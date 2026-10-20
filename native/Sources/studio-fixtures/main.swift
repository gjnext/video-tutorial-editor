import AVFoundation
import CoreText
import ImageIO
import Foundation
import StudioNative

/// Test media generator.
///   video <out.mp4> <seconds> <width> <height> <fps>
///     Synthetic SaaS UI with browser chrome. Each frame carries its index as a
///     16-bit barcode (row of black/white cells at the bottom-left) so exported
///     frames can be mapped back to source frames programmatically. The page
///     "navigates" (content color change) at 5.1 s.
///   audio <out.wav|out.m4a> <seconds> <beepSec,beepSec,...> <sampleRate> <channels>
///     Silence with 80 ms 1 kHz beeps at the given times.

let BARCODE_BITS = 16
let BARCODE_CELL = 24 // px in source

func drawText(_ ctx: CGContext, _ s: String, x: CGFloat, y: CGFloat, size: CGFloat, color: CGColor, h: CGFloat) {
    let font = CTFontCreateWithName("Helvetica Neue" as CFString, size, nil)
    let attr = NSAttributedString(string: s, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font,
                                                         NSAttributedString.Key(kCTForegroundColorAttributeName as String): color])
    let line = CTLineCreateWithAttributedString(attr)
    ctx.textPosition = CGPoint(x: x, y: h - y - size)
    CTLineDraw(line, ctx)
}

func makeVideo(out: String, seconds: Double, w: Int, h: Int, fps: Int32) async throws {
    let url = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12_000_000, AVVideoMaxKeyFrameIntervalKey: Int(fps)],
    ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
    ])
    writer.add(input)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    let n = Int((seconds * Double(fps)).rounded())
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let H = CGFloat(h)
    for i in 0..<n {
        var pbo: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pbo)
        let pb = pbo!
        CVPixelBufferLockBaseAddress(pb, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
                            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        let t = Double(i) / Double(fps)
        func rect(_ x: CGFloat, _ y: CGFloat, _ rw: CGFloat, _ rh: CGFloat, _ c: CGColor) { ctx.setFillColor(c); ctx.fill(CGRect(x: x, y: H - y - rh, width: rw, height: rh)) }
        let navigated = t >= 5.1
        // Page
        rect(0, 0, CGFloat(w), H, navigated ? CGColor(red: 0.95, green: 0.97, blue: 1, alpha: 1) : CGColor(red: 0.97, green: 0.97, blue: 0.98, alpha: 1))
        // Browser chrome: tab strip + address bar (to be cropped away)
        rect(0, 0, CGFloat(w), 56, CGColor(red: 0.82, green: 0.83, blue: 0.86, alpha: 1))
        rect(16, 10, 260, 46, CGColor(red: 0.97, green: 0.97, blue: 0.98, alpha: 1))
        drawText(ctx, "Acme Dashboard", x: 34, y: 22, size: 18, color: CGColor(gray: 0.15, alpha: 1), h: H)
        rect(0, 56, CGFloat(w), 64, CGColor(red: 0.97, green: 0.97, blue: 0.98, alpha: 1))
        rect(120, 70, CGFloat(w) - 240, 36, CGColor(red: 0.9, green: 0.91, blue: 0.93, alpha: 1))
        drawText(ctx, "app.acme.example/dashboard", x: 140, y: 78, size: 17, color: CGColor(gray: 0.35, alpha: 1), h: H)
        rect(0, 120, CGFloat(w), 2, CGColor(gray: 0.8, alpha: 1))
        // Sidebar
        rect(0, 122, 280, H - 122, CGColor(red: 0.13, green: 0.15, blue: 0.22, alpha: 1))
        let items = ["Overview", "Projects", "Reports", "Team", "Settings"]
        for (k, label) in items.enumerated() {
            let y = 170 + CGFloat(k) * 58
            if (label == "Settings" && navigated) || (label == "Overview" && !navigated) { rect(16, y - 12, 248, 46, CGColor(red: 0.3, green: 0.36, blue: 0.95, alpha: 1)) }
            drawText(ctx, label, x: 40, y: y, size: 22, color: CGColor(gray: 1, alpha: 1), h: H)
        }
        // Content
        drawText(ctx, navigated ? "Settings" : "Overview", x: 340, y: 160, size: 44, color: CGColor(gray: 0.1, alpha: 1), h: H)
        for c in 0..<3 {
            let x = 340 + CGFloat(c) * 420
            rect(x, 250, 390, 220, CGColor(gray: 1, alpha: 1))
            rect(x, 250, 390, 4, CGColor(red: 0.3 + 0.2 * CGFloat(c), green: 0.4, blue: 0.9, alpha: 1))
            drawText(ctx, navigated ? "Option \(c + 1)" : "Metric \(c + 1)", x: x + 24, y: 280, size: 24, color: CGColor(gray: 0.2, alpha: 1), h: H)
        }
        // Moving progress bar proves motion continuity.
        let bw = CGFloat(w) - 400
        rect(340, 520, bw, 18, CGColor(gray: 0.88, alpha: 1))
        rect(340, 520, bw * CGFloat(t / seconds), 18, CGColor(red: 0.3, green: 0.36, blue: 0.95, alpha: 1))
        drawText(ctx, String(format: "t = %.2f s  ·  frame %d", t, i), x: 340, y: 560, size: 26, color: CGColor(gray: 0.3, alpha: 1), h: H)
        // "Save" button target
        rect(CGFloat(w) - 260, 150, 180, 54, CGColor(red: 0.3, green: 0.36, blue: 0.95, alpha: 1))
        drawText(ctx, "Save", x: CGFloat(w) - 200, y: 163, size: 24, color: CGColor(gray: 1, alpha: 1), h: H)
        // Frame-index barcode (bottom-left, above the sidebar bottom): white border + 16 cells.
        let by = H - CGFloat(BARCODE_CELL) * 2
        rect(300, by - 8, CGFloat(BARCODE_BITS * BARCODE_CELL) + 16, CGFloat(BARCODE_CELL) + 16, CGColor(gray: 1, alpha: 1))
        for b in 0..<BARCODE_BITS {
            let on = (i >> (BARCODE_BITS - 1 - b)) & 1 == 1
            rect(308 + CGFloat(b * BARCODE_CELL), by, CGFloat(BARCODE_CELL), CGFloat(BARCODE_CELL), on ? CGColor(gray: 0, alpha: 1) : CGColor(gray: 1, alpha: 1))
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
        adaptor.append(pb, withPresentationTime: CMTime(value: Int64(i), timescale: fps))
    }
    input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else { throw StudioError("fixture write failed: \(String(describing: writer.error))") }
    IO.result(["path": out, "frames": n])
}

func makeAudio(out: String, seconds: Double, beeps: [Double], sampleRate: Double, channels: Int) throws {
    let url = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: url)
    let isWav = url.pathExtension.lowercased() == "wav"
    let settings: [String: Any] = isWav
        ? [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels, AVLinearPCMBitDepthKey: 16,
           AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
        : [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: 128000]
    let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    let total = AVAudioFrameCount(seconds * sampleRate)
    let fmt = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: AVAudioChannelCount(channels))!
    let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: total)!
    buf.frameLength = total
    for c in 0..<channels {
        let d = buf.floatChannelData![c]
        for i in 0..<Int(total) { d[i] = 0 }
        for b in beeps {
            let s0 = Int(b * sampleRate)
            let len = Int(0.08 * sampleRate)
            for k in 0..<len where s0 + k < Int(total) {
                d[s0 + k] = 0.5 * Float(sin(2 * Double.pi * 1000 * Double(k) / sampleRate))
            }
        }
    }
    try file.write(from: buf)
    IO.result(["path": out])
}

// ---------------------------------------------------------------- analysis (tests)

func loadRGBA(_ path: String) throws -> (w: Int, h: Int, data: [UInt8]) {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw StudioError("cannot read \(path)") }
    let w = img.width, h = img.height
    var data = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (w, h, data)
}

/// pixels <png> "x,y;x,y" → RGB at each (top-left origin) point.
func samplePixels(_ path: String, _ spec: String) throws {
    let img = try loadRGBA(path)
    var out: [[Int]] = []
    for pair in spec.split(separator: ";") {
        let xy = pair.split(separator: ",").compactMap { Double($0) }
        let x = min(img.w - 1, max(0, Int(xy[0]))), y = min(img.h - 1, max(0, Int(xy[1])))
        let o = (y * img.w + x) * 4
        out.append([Int(img.data[o]), Int(img.data[o + 1]), Int(img.data[o + 2])])
    }
    IO.result(["pixels": out, "width": img.w, "height": img.h])
}

/// compare <a.png> <b.png> <threshold> → mean abs diff and bbox of pixels differing by > threshold.
func compareImages(_ a: String, _ b: String, _ threshold: Int) throws {
    let A = try loadRGBA(a), B = try loadRGBA(b)
    guard A.w == B.w && A.h == B.h else { throw StudioError("size mismatch \(A.w)x\(A.h) vs \(B.w)x\(B.h)") }
    var sum = 0.0, maxd = 0
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1, count = 0
    for y in 0..<A.h {
        for x in 0..<A.w {
            let o = (y * A.w + x) * 4
            var d = 0
            for c in 0..<3 { d = max(d, abs(Int(A.data[o + c]) - Int(B.data[o + c]))) }
            sum += Double(d)
            maxd = max(maxd, d)
            if d > threshold { count += 1; minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y) }
        }
    }
    var r: [String: Any] = ["mean": sum / Double(A.w * A.h), "max": maxd, "count": count]
    if count > 0 { r["bbox"] = [minX, minY, maxX, maxY] }
    IO.result(r)
}

/// beeps <media> <threshold> → onset times (s) of loud segments in the first audio track.
func detectBeeps(_ path: String, _ threshold: Float) async throws {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw StudioError("no audio track") }
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000,
        AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
    reader.add(out)
    reader.startReading()
    var onsets: [Double] = []
    var lastLoud = -10.0
    var totalFrames = 0
    var peak: Float = 0
    var firstPTS: Double? = nil
    while let sb = out.copyNextSampleBuffer() {
        guard let bb = CMSampleBufferGetDataBuffer(sb), let fd = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee else { continue }
        let ch = Int(asbd.mChannelsPerFrame)
        let n = CMSampleBufferGetNumSamples(sb)
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        if firstPTS == nil { firstPTS = pts }
        var len = 0; var ptr: UnsafeMutablePointer<CChar>?
        CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
        let f = UnsafeRawPointer(ptr!).assumingMemoryBound(to: Float.self)
        for i in 0..<n {
            let v = abs(f[i * ch])
            peak = max(peak, v)
            if v > threshold {
                let t = pts + Double(i) / 48000
                if t - lastLoud > 0.2 { onsets.append(t) }
                lastLoud = t
            }
        }
        totalFrames += n
    }
    IO.result(["onsets": onsets, "duration": Double(totalFrames) / 48000, "peak": peak, "firstPTS": firstPTS ?? 0])
}

let a = CommandLine.arguments
Task {
    do {
        switch a.count > 1 ? a[1] : "" {
        case "video": try await makeVideo(out: a[2], seconds: Double(a[3])!, w: Int(a[4])!, h: Int(a[5])!, fps: Int32(a[6])!)
        case "pixels": try samplePixels(a[2], a[3])
        case "compare": try compareImages(a[2], a[3], Int(a[4]) ?? 8)
        case "beeps": try await detectBeeps(a[2], Float(a[3]) ?? 0.1)
        case "audio": try makeAudio(out: a[2], seconds: Double(a[3])!, beeps: a[4].split(separator: ",").compactMap { Double($0) }, sampleRate: Double(a[5])!, channels: Int(a[6])!)
        default: IO.fail("usage: studio-fixtures video|audio ...")
        }
        exit(0)
    } catch { IO.fail("\(error)") }
}
dispatchMain()
