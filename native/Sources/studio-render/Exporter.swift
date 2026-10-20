import AVFoundation
import CoreImage
import StudioNative
import VideoToolbox

final class Exporter {
    let plan: RenderPlan
    private var cancelled = false
    private let lock = NSLock()

    init(plan: RenderPlan) { self.plan = plan }

    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    func run() async throws {
        let o = plan.output
        let finalURL = URL(fileURLWithPath: o.path)
        let tmpURL = finalURL.deletingLastPathComponent().appendingPathComponent(".\(finalURL.deletingPathExtension().lastPathComponent).partial.mp4")
        try? FileManager.default.removeItem(at: tmpURL)

        let writer = try AVAssetWriter(outputURL: tmpURL, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true // moov atom first: YouTube/web friendly

        let isHEVC = o.codec == "hevc"
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: o.videoBitrate,
            AVVideoMaxKeyFrameIntervalKey: o.keyframeIntervalFrames,
            AVVideoExpectedSourceFrameRateKey: Double(o.fpsNum) / Double(o.fpsDen),
            AVVideoAllowFrameReorderingKey: true,
        ]
        if isHEVC {
            compression[AVVideoProfileLevelKey] = kVTProfileLevel_HEVC_Main_AutoLevel as String
        } else {
            compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
            compression[AVVideoH264EntropyModeKey] = AVVideoH264EntropyModeCABAC
        }
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: isHEVC ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: o.width,
            AVVideoHeightKey: o.height,
            AVVideoCompressionPropertiesKey: compression,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        guard writer.canApply(outputSettings: videoSettings, forMediaType: .video) else {
            throw StudioError("This Mac cannot encode \(isHEVC ? "HEVC" : "H.264") at \(o.width)×\(o.height).", code: "encoder")
        }
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: o.width,
            kCVPixelBufferHeightKey as String: o.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ])
        writer.add(videoInput)

        var audioInput: AVAssetWriterInput?
        var mixer: AudioMixer?
        if !plan.audio.isEmpty {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: o.sampleRate,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: o.audioBitrate,
            ])
            a.expectsMediaDataInRealTime = false
            writer.add(a)
            audioInput = a
            mixer = AudioMixer(placements: plan.audio, sampleRate: o.sampleRate, duration: plan.duration)
        }

        var sources: [String: VideoFrameSource] = [:]
        for asset in plan.assets where asset.kind == "video" {
            sources[asset.id] = try await VideoFrameSource(path: asset.path)
        }
        defer { sources.values.forEach { $0.close() }; mixer?.close() }

        let compositor = Compositor(plan: plan)
        guard writer.startWriting() else { throw StudioError("Cannot start writer: \(writer.error?.localizedDescription ?? "")", code: "writer") }
        writer.startSession(atSourceTime: .zero)

        let started = Date()
        var lastReport = Date.distantPast
        let total = plan.frames.count

        // Feed audio up to `time` seconds (interleaving keeps the writer from stalling).
        // The audio input must be marked finished as soon as the mix is complete,
        // otherwise the writer keeps waiting for audio and stops accepting video.
        var audioDone = false
        func pumpAudio(until seconds: Double) async throws {
            guard let ai = audioInput, let m = mixer, !audioDone else { return }
            while !m.finished && Double(m.position) / Double(o.sampleRate) < seconds && ai.isReadyForMoreMediaData {
                if let sb = try await m.nextChunk() {
                    if !ai.append(sb) { throw StudioError("Audio encoding failed: \(writer.error?.localizedDescription ?? "")", code: "writer") }
                }
            }
            if m.finished {
                ai.markAsFinished()
                audioDone = true
            }
        }

        for (i, frame) in plan.frames.enumerated() {
            if isCancelled { break }
            let pb: CVPixelBuffer = try autoreleasepool {
                let image = try compositor.compose(frame, sources: sources)
                guard let pool = adaptor.pixelBufferPool else { throw StudioError("No pixel buffer pool", code: "writer") }
                var pbOut: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut)
                guard let pb = pbOut else { throw StudioError("Pixel buffer allocation failed", code: "memory") }
                CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
                CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
                CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
                compositor.context.render(image, to: pb, bounds: CGRect(x: 0, y: 0, width: o.width, height: o.height), colorSpace: sRGB)
                return pb
            }
            let pts = CMTime(value: Int64(i) * o.fpsDen, timescale: o.fpsNum)
            let frameSeconds = CMTimeGetSeconds(pts)
            while !videoInput.isReadyForMoreMediaData {
                if writer.status == .failed { throw StudioError("Encoder failed: \(writer.error?.localizedDescription ?? "")", code: "writer") }
                try await pumpAudio(until: frameSeconds + 1.0)
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            if !adaptor.append(pb, withPresentationTime: pts) {
                throw StudioError("Video encoding failed: \(writer.error?.localizedDescription ?? "")", code: "writer")
            }
            try await pumpAudio(until: frameSeconds + 0.5)
            let now = Date()
            if now.timeIntervalSince(lastReport) > 0.2 || i == total - 1 {
                lastReport = now
                let el = now.timeIntervalSince(started)
                IO.progress(["phase": "video", "frame": i + 1, "total": total, "fps": el > 0 ? Double(i + 1) / el : 0])
            }
        }

        if isCancelled {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: tmpURL)
            IO.event("cancelled")
            return
        }

        videoInput.markAsFinished()
        if let ai = audioInput, let m = mixer, !audioDone {
            IO.progress(["phase": "audio", "frame": total, "total": total])
            while !m.finished {
                if isCancelled { break }
                while !ai.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
                if let sb = try await m.nextChunk() { if !ai.append(sb) { throw StudioError("Audio encoding failed", code: "writer") } }
            }
            ai.markAsFinished()
            audioDone = true
        }
        IO.progress(["phase": "finalizing", "frame": total, "total": total])
        await writer.finishWriting()
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: tmpURL)
            throw StudioError("Could not finalize the video: \(writer.error?.localizedDescription ?? "unknown error")", code: "writer")
        }
        try? FileManager.default.removeItem(at: finalURL)
        try FileManager.default.moveItem(at: tmpURL, to: finalURL)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: finalURL.path)[.size] as? Int) ?? 0
        IO.result(["path": finalURL.path, "bytes": bytes, "frames": total, "seconds": Date().timeIntervalSince(started)])
    }
}
