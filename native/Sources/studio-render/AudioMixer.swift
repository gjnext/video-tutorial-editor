import AVFoundation
import StudioNative

/// Streams one audio placement as 48 kHz stereo float samples, sequentially.
/// Sample k of the placement plays at project sample (startSample + k).
final class PlacementReader {
    let p: AudioPlacement
    let startSample: Int64
    let length: Int64
    let sampleRate: Double
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    /// Interleaved stereo samples not yet consumed, beginning at `bufferStart` (placement-relative).
    private var buffer: [Float] = []
    private var bufferStart: Int64 = 0
    private var exhausted = false
    private var opened = false

    init(_ p: AudioPlacement, sampleRate: Int) {
        self.p = p
        self.sampleRate = Double(sampleRate)
        let fpS = FLICKS_PER_SECOND / Int64(sampleRate) // exact for 48k (14700)
        startSample = p.start / fpS
        length = (p.sourceOut - p.sourceIn) / fpS
    }

    private func open() async throws {
        opened = true
        let asset = AVURLAsset(url: URL(fileURLWithPath: p.path), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { exhausted = true; return }
        let r = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let o = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        o.alwaysCopiesSampleData = false
        r.add(o)
        // Start slightly early; samples before sourceIn are discarded using PTS.
        let start = CMTimeMaximum(.zero, CMTimeSubtract(CMTime(flicks: p.sourceIn), CMTime(seconds: 0.25, preferredTimescale: 48000)))
        r.timeRange = CMTimeRange(start: start, end: CMTimeAdd(CMTime(flicks: p.sourceOut), CMTime(seconds: 0.25, preferredTimescale: 48000)))
        guard r.startReading() else { throw StudioError("Cannot decode audio \(URL(fileURLWithPath: p.path).lastPathComponent): \(r.error?.localizedDescription ?? "")", code: "audio-decode") }
        reader = r
        output = o
    }

    /// Append decoded samples until the buffer covers placement-relative index `upTo`.
    private func fill(upTo: Int64) {
        guard let o = output else { return }
        let sourceInSec = Double(p.sourceIn) / Double(FLICKS_PER_SECOND)
        while !exhausted && bufferStart + Int64(buffer.count / 2) < upTo {
            guard let sb = o.copyNextSampleBuffer() else { exhausted = true; break }
            guard let fd = CMSampleBufferGetFormatDescription(sb),
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee,
                  let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
            let channels = Int(asbd.mChannelsPerFrame)
            let frames = CMSampleBufferGetNumSamples(sb)
            var length = 0
            var ptr: UnsafeMutablePointer<CChar>?
            guard CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &ptr) == noErr, let raw = ptr else { continue }
            let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
            var rel = Int64(((pts - sourceInSec) * sampleRate).rounded())
            let floats = UnsafeRawPointer(raw).assumingMemoryBound(to: Float.self)
            var startFrame = 0
            if rel < 0 { startFrame = Int(min(Int64(frames), -rel)); rel = 0 }
            let expected = bufferStart + Int64(buffer.count / 2)
            if rel > expected { buffer += [Float](repeating: 0, count: Int(rel - expected) * 2) } // gap → silence
            let dropFront = rel < expected ? Int(expected - rel) : 0 // overlap → skip
            let first = startFrame + dropFront
            if first >= frames { continue }
            buffer.reserveCapacity(buffer.count + (frames - first) * 2)
            for f in first..<frames {
                let l = floats[f * channels]
                let r = channels > 1 ? floats[f * channels + 1] : l
                buffer.append(l)
                buffer.append(r)
            }
        }
    }

    /// Mix this placement into `out` (interleaved stereo) for project samples [from, from+count).
    func mix(into out: inout [Float], from: Int64, count: Int, fadeTable: (Int64) -> Double) async throws {
        let relStart = from - startSample
        let relEnd = relStart + Int64(count)
        if relEnd <= 0 || relStart >= length { return }
        if !opened { try await open() }
        let a = max(relStart, 0)
        let b = min(relEnd, length)
        fill(upTo: b)
        // Drop consumed samples older than `a`.
        if a > bufferStart {
            let drop = Int(min(Int64(buffer.count / 2), a - bufferStart))
            buffer.removeFirst(drop * 2)
            bufferStart += Int64(drop)
        }
        var i = a
        while i < b {
            let idx = Int(i - bufferStart)
            if idx < 0 || idx * 2 + 1 >= buffer.count { break }
            let g = Float(fadeTable(i))
            let o = Int(i - relStart) * 2
            out[o] += buffer[idx * 2] * g
            out[o + 1] += buffer[idx * 2 + 1] * g
            i += 1
        }
    }

    /// Linear envelope identical to shared/audio.ts gainAt(), in samples.
    func gain(atRelative i: Int64) -> Double {
        let fpS = Double(FLICKS_PER_SECOND) / sampleRate
        let local = Double(i) * fpS
        let dur = Double(p.sourceOut - p.sourceIn)
        if local < 0 || local >= dur { return 0 }
        var g = p.gain
        if p.fadeIn > 0 && local < Double(p.fadeIn) { g *= local / Double(p.fadeIn) }
        let remain = dur - local
        if p.fadeOut > 0 && remain < Double(p.fadeOut) { g *= remain / Double(p.fadeOut) }
        return g
    }

    func close() { reader?.cancelReading() }
}

final class AudioMixer {
    let readers: [PlacementReader]
    let sampleRate: Int
    let totalSamples: Int64
    private(set) var position: Int64 = 0
    private var format: CMAudioFormatDescription?

    init(placements: [AudioPlacement], sampleRate: Int, duration: Int64) {
        self.sampleRate = sampleRate
        readers = placements.map { PlacementReader($0, sampleRate: sampleRate) }
        totalSamples = (duration * Int64(sampleRate) + FLICKS_PER_SECOND - 1) / FLICKS_PER_SECOND
        var asbd = AudioStreamBasicDescription(mSampleRate: Float64(sampleRate), mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2,
                                               mBitsPerChannel: 32, mReserved: 0)
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    }

    var finished: Bool { position >= totalSamples }

    /// Next chunk of mixed audio as a CMSampleBuffer, or nil at the end.
    func nextChunk(maxFrames: Int = 4096) async throws -> CMSampleBuffer? {
        if finished { return nil }
        let count = Int(min(Int64(maxFrames), totalSamples - position))
        var mix = [Float](repeating: 0, count: count * 2)
        for r in readers {
            try await r.mix(into: &mix, from: position, count: count) { r.gain(atRelative: $0) }
        }
        for i in 0..<mix.count { mix[i] = max(-1, min(1, mix[i])) }
        let pts = CMTime(value: position, timescale: CMTimeScale(sampleRate))
        position += Int64(count)
        return try makeSampleBuffer(mix, frames: count, pts: pts)
    }

    private func makeSampleBuffer(_ samples: [Float], frames: Int, pts: CMTime) throws -> CMSampleBuffer {
        let bytes = frames * 8
        var block: CMBlockBuffer?
        var st = CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil,
                                                    offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        guard st == noErr, let block else { throw StudioError("audio block alloc failed") }
        samples.withUnsafeBytes { raw in
            _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes)
        }
        var sb: CMSampleBuffer?
        st = CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: format!, sampleCount: frames,
                                                                 presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &sb)
        guard st == noErr, let sb else { throw StudioError("audio sample buffer failed (\(st))") }
        return sb
    }

    func close() { readers.forEach { $0.close() } }
}
