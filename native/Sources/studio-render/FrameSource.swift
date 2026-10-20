import AVFoundation
import CoreImage
import StudioNative

/// Sequential frame access for one video asset.
///
/// Frame selection rule (docs/COMPOSITION_SPEC.md §1.3): for a requested source
/// time s, show the latest decoded frame with pts ≤ s + 0.5 ms. Forward requests
/// decode sequentially; backwards or far jumps restart the reader ≥1 s earlier.
final class VideoFrameSource {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let transform: CGAffineTransform
    let naturalSize: CGSize
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var current: (pts: CMTime, buffer: CVPixelBuffer)?
    private var next: (pts: CMTime, buffer: CVPixelBuffer)?
    private var ended = false
    private let tolerance = CMTime(value: 1, timescale: 2000)

    init(path: String) async throws {
        asset = AVURLAsset(url: URL(fileURLWithPath: path), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let t = try await asset.loadTracks(withMediaType: .video).first else {
            throw StudioError("No video track in \(URL(fileURLWithPath: path).lastPathComponent)", code: "no-video")
        }
        track = t
        transform = try await t.load(.preferredTransform)
        naturalSize = try await t.load(.naturalSize)
    }

    private func restart(at time: CMTime) throws {
        reader?.cancelReading()
        let r = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        let o = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        o.alwaysCopiesSampleData = false
        o.supportsRandomAccess = false
        guard r.canAdd(o) else { throw StudioError("Cannot read video track", code: "decode") }
        r.add(o)
        let start = CMTimeMaximum(.zero, CMTimeSubtract(time, CMTime(seconds: 1, preferredTimescale: 600)))
        r.timeRange = CMTimeRange(start: start, duration: .positiveInfinity)
        guard r.startReading() else { throw StudioError("Decoder failed: \(r.error?.localizedDescription ?? "unknown")", code: "decode") }
        reader = r
        output = o
        current = nil
        next = nil
        ended = false
    }

    private func readNext() -> (pts: CMTime, buffer: CVPixelBuffer)? {
        guard !ended, let o = output else { return nil }
        while let sb = o.copyNextSampleBuffer() {
            if let pb = CMSampleBufferGetImageBuffer(sb) {
                return (CMSampleBufferGetPresentationTimeStamp(sb), pb)
            }
        }
        if let r = reader, r.status == .failed {
            IO.log("decoder error: \(r.error?.localizedDescription ?? "?")")
        }
        ended = true
        return nil
    }

    /// Pixel buffer for the frame visible at source time `flicks`.
    func frame(atFlicks flicks: Int64) throws -> CVPixelBuffer? {
        let want = CMTimeAdd(CMTime(flicks: flicks), tolerance)
        let needsRestart: Bool
        if let cur = current {
            let behind = CMTimeCompare(want, cur.pts) < 0
            let farAhead = CMTimeGetSeconds(CMTimeSubtract(want, cur.pts)) > 3
            needsRestart = behind || farAhead
        } else {
            needsRestart = true
        }
        if needsRestart {
            try restart(at: CMTime(flicks: flicks))
            current = readNext()
            next = readNext()
        }
        while let n = next, CMTimeCompare(n.pts, want) <= 0 {
            current = n
            next = readNext()
        }
        return current?.buffer
    }

    /// CIImage of a pixel buffer in display orientation, origin at (0,0).
    func orientedImage(_ pb: CVPixelBuffer) -> CIImage {
        var img = CIImage(cvPixelBuffer: pb)
        if !transform.isIdentity {
            // preferredTransform is defined in a y-down space; convert for Core Image.
            let w = naturalSize.width, h = naturalSize.height
            let flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: h)
            let t = flip.concatenating(transform)
            let bounds = CGRect(x: 0, y: 0, width: w, height: h).applying(transform)
            let flipBack = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: abs(bounds.height))
            img = img.transformed(by: t.concatenating(flipBack))
            img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
        }
        return img
    }

    func close() {
        reader?.cancelReading()
        reader = nil
    }
}
