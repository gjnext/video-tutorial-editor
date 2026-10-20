import AVFoundation
import StudioNative

/// Editing proxy for fast scrubbing in the preview: downscaled, very short GOP
/// (keyframe every few frames) so any seek decodes at most a handful of small
/// frames. Timestamps are copied 1:1 from the source, so proxy time == source time.
/// Never used for export.
enum Proxy {
    static func run(input: String, output: String, maxWidth: Int) async throws -> [String: Any] {
        let asset = AVURLAsset(url: URL(fileURLWithPath: input), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw StudioError("No video track", code: "no-video") }
        let natural = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let display = CGRect(origin: .zero, size: natural).applying(transform).size
        let dw = abs(display.width), dh = abs(display.height)
        let scale = min(1, Double(maxWidth) / Double(dw))
        // Decoder output size is in the track's natural orientation.
        func even(_ v: Double) -> Int { max(2, Int((v / 2).rounded()) * 2) }
        let ow = even(Double(natural.width) * scale), oh = even(Double(natural.height) * scale)

        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: ow,
            kCVPixelBufferHeightKey as String: oh,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ])
        out.alwaysCopiesSampleData = false
        reader.add(out)

        let url = URL(fileURLWithPath: output)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).partial.mp4")
        try? FileManager.default.removeItem(at: tmp)
        let writer = try AVAssetWriter(outputURL: tmp, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: ow,
            AVVideoHeightKey: oh,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(2_000_000, ow * oh * 4),
                AVVideoMaxKeyFrameIntervalKey: 4,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
        ])
        input.transform = transform
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        guard reader.startReading(), writer.startWriting() else { throw StudioError("Cannot create proxy: \(reader.error?.localizedDescription ?? writer.error?.localizedDescription ?? "")") }
        writer.startSession(atSourceTime: .zero)
        var frames = 0
        var last = CMTime.negativeInfinity
        while let sb = out.copyNextSampleBuffer() {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb)
            guard CMTimeCompare(pts, last) > 0 else { continue }
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            if adaptor.append(pb, withPresentationTime: pts) { frames += 1; last = pts }
        }
        if reader.status == .failed { throw StudioError("Proxy decode failed: \(reader.error?.localizedDescription ?? "")") }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw StudioError("Proxy write failed: \(writer.error?.localizedDescription ?? "")") }
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: tmp, to: url)
        let w = abs(CGRect(x: 0, y: 0, width: ow, height: oh).applying(transform).width)
        let h = abs(CGRect(x: 0, y: 0, width: ow, height: oh).applying(transform).height)
        return ["path": output, "width": Int(w), "height": Int(h), "frames": frames]
    }
}
