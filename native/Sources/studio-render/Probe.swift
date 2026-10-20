import AVFoundation
import ImageIO
import StudioNative
import UniformTypeIdentifiers

enum Probe {
    static let imageExts: Set<String> = ["png", "jpg", "jpeg", "heic", "tif", "tiff", "webp", "gif", "bmp"]

    static func run(path: String) async throws -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { throw StudioError("File not found: \(path)", code: "missing") }
        if imageExts.contains(url.pathExtension.lowercased()) {
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else {
                throw StudioError("Unsupported image: \(url.lastPathComponent)", code: "unsupported")
            }
            var w = props[kCGImagePropertyPixelWidth] as? Int ?? 0
            var h = props[kCGImagePropertyPixelHeight] as? Int ?? 0
            if let o = props[kCGImagePropertyOrientation] as? Int, o >= 5 { swap(&w, &h) }
            return ["kind": "image", "duration": 0, "width": w, "height": h]
        }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let playable = try await asset.load(.isPlayable)
        let duration = try await asset.load(.duration)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        if videoTracks.isEmpty && audioTracks.isEmpty {
            throw StudioError("\(url.lastPathComponent) contains no audio or video.", code: "unsupported")
        }
        var out: [String: Any] = [
            "duration": CMTimeGetSeconds(duration),
            "hasVideo": !videoTracks.isEmpty,
            "hasAudio": !audioTracks.isEmpty,
            "playable": playable,
        ]
        if let v = videoTracks.first {
            let size = try await v.load(.naturalSize)
            let t = try await v.load(.preferredTransform)
            let r = CGRect(origin: .zero, size: size).applying(t)
            out["kind"] = "video"
            out["width"] = Int(abs(r.width).rounded())
            out["height"] = Int(abs(r.height).rounded())
            out["frameRate"] = Double(try await v.load(.nominalFrameRate))
            let fmts = try await v.load(.formatDescriptions)
            if let f = fmts.first {
                let code = CMFormatDescriptionGetMediaSubType(f)
                out["codec"] = fourCC(code)
            }
            let range = try await v.load(.timeRange)
            out["startTime"] = CMTimeGetSeconds(range.start)
        } else {
            out["kind"] = "audio"
        }
        if let a = audioTracks.first {
            let fmts = try await a.load(.formatDescriptions)
            if let f = fmts.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(f)?.pointee {
                out["sampleRate"] = asbd.mSampleRate
                out["channels"] = Int(asbd.mChannelsPerFrame)
                if videoTracks.isEmpty { out["codec"] = fourCC(asbd.mFormatID) }
            }
        }
        return out
    }

    static func fourCC(_ code: FourCharCode) -> String {
        let chars = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((code >> $0) & 0xff))) }
        return String(chars).trimmingCharacters(in: .whitespaces)
    }
}

enum Thumbnails {
    /// Writes JPEG thumbnails every `interval` seconds into `outDir`.
    static func run(path: String, outDir: String, interval: Double, height: Int) async throws -> [String: Any] {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let duration = CMTimeGetSeconds(try await asset.load(.duration))
        try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: height * 4, height: height)
        let tol = CMTime(seconds: interval / 2, preferredTimescale: 600)
        gen.requestedTimeToleranceBefore = tol
        gen.requestedTimeToleranceAfter = tol
        let count = max(1, Int(ceil(duration / interval)))
        var files: [String] = []
        var w = 0, h = 0
        for i in 0..<count {
            let t = CMTime(seconds: min(Double(i) * interval, max(0, duration - 0.05)), preferredTimescale: 600)
            let (img, _) = try await gen.image(at: t)
            w = img.width; h = img.height
            let file = (outDir as NSString).appendingPathComponent(String(format: "t%05d.jpg", i))
            try writeJPEG(img, to: file, quality: 0.72)
            files.append(file)
        }
        return ["files": files, "interval": interval, "width": w, "height": h]
    }

    static func writeJPEG(_ img: CGImage, to path: String, quality: Double) throws {
        guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw StudioError("Cannot write \(path)")
        }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw StudioError("Cannot write \(path)") }
    }

    static func writePNG(_ img: CGImage, to path: String) throws {
        guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw StudioError("Cannot write \(path)")
        }
        CGImageDestinationAddImage(dest, img, nil)
        guard CGImageDestinationFinalize(dest) else { throw StudioError("Cannot write \(path)") }
    }
}
