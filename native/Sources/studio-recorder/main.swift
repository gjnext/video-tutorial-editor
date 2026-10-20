import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import StudioNative
import UniformTypeIdentifiers

/// studio-recorder — native screen capture for Tutorial Studio (ScreenCaptureKit).
///
///   permission                      → {status: granted|denied}   (never prompts)
///   request-permission              → {status}                    (shows the system prompt once)
///   list <thumbDir> [excludePid]    → {displays:[...], windows:[...]}
///   record <configJSON>             → events: ready, started, progress, finalizing; result {path,...}
///       stdin commands: "start" (begin writing after countdown), "stop", "cancel"
///
/// The real system cursor is excluded from recordings (showsCursor = false);
/// Tutorial Studio adds a synthetic cursor afterwards.

struct RecordConfig: Decodable {
    let mode: String // display | window | region
    let displayId: UInt32?
    let windowId: UInt32?
    let region: Region?
    let fps: Int
    let showCursor: Bool
    let output: String
    let excludePid: Int32?
    /// Test-only: after recording, verify the system cursor is absent from the output.
    let selfTest: Bool?

    struct Region: Decodable { let x: Double; let y: Double; let w: Double; let h: Double }
}

func even(_ v: Double) -> Int { max(2, Int((v / 2).rounded()) * 2) }

func writeJPEG(_ img: CGImage, _ path: String) {
    guard let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(d, img, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
    CGImageDestinationFinalize(d)
}

func permissionStatus() -> String { CGPreflightScreenCaptureAccess() ? "granted" : "denied" }

func listSources(thumbDir: String, excludePid: Int32?) async throws {
    guard CGPreflightScreenCaptureAccess() else { throw StudioError("Screen Recording permission is not granted.", code: "permission") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    try? FileManager.default.createDirectory(atPath: thumbDir, withIntermediateDirectories: true)
    var displays: [[String: Any]] = []
    for (i, d) in content.displays.enumerated() {
        let filter = SCContentFilter(display: d, excludingWindows: [])
        let scale = Double(filter.pointPixelScale)
        var entry: [String: Any] = ["id": d.displayID, "width": d.width, "height": d.height, "scale": scale,
                                    "name": i == 0 ? "Main Display" : "Display \(i + 1)"]
        let cfg = SCStreamConfiguration()
        cfg.width = 640
        cfg.height = max(2, Int(640.0 * Double(d.height) / Double(d.width)))
        cfg.showsCursor = false
        if let img = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) {
            let p = (thumbDir as NSString).appendingPathComponent("display-\(d.displayID).jpg")
            writeJPEG(img, p)
            entry["thumbnail"] = p
        }
        displays.append(entry)
    }
    var windows: [[String: Any]] = []
    let candidates = content.windows.filter { w in
        guard w.windowLayer == 0, w.frame.width >= 160, w.frame.height >= 120, let app = w.owningApplication else { return false }
        if let ex = excludePid, app.processID == ex { return false }
        if app.bundleIdentifier == "com.apple.dock" || app.bundleIdentifier == "com.apple.WindowManager" { return false }
        return true
    }.prefix(40)
    for w in candidates {
        let app = w.owningApplication!
        let display = content.displays.first { $0.frame.intersects(w.frame) }
        var entry: [String: Any] = ["id": w.windowID, "title": w.title ?? "", "app": app.applicationName, "bundleId": app.bundleIdentifier,
                                    "width": Int(w.frame.width), "height": Int(w.frame.height), "displayId": display?.displayID ?? 0]
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let cfg = SCStreamConfiguration()
        cfg.width = 480
        cfg.height = max(2, Int(480.0 * w.frame.height / w.frame.width))
        cfg.showsCursor = false
        cfg.ignoreShadowsSingleWindow = true
        if let img = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) {
            let p = (thumbDir as NSString).appendingPathComponent("window-\(w.windowID).jpg")
            writeJPEG(img, p)
            entry["thumbnail"] = p
        }
        windows.append(entry)
    }
    IO.result(["displays": displays, "windows": windows])
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let config: RecordConfig
    private var stream: SCStream?
    private var writer: AVAssetWriter!
    private var input: AVAssetWriterInput!
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor!
    private let queue = DispatchQueue(label: "studio.recorder.frames")
    private var writing = false
    private var sessionStart: CMTime?
    private var lastPTS: CMTime = .zero
    private var lastBuffer: CVPixelBuffer?
    private var frames = 0
    private var lastProgress = Date.distantPast
    private(set) var width = 0
    private(set) var height = 0
    private var tmpURL: URL!
    private var finalURL: URL!
    private var failed: String?

    init(config: RecordConfig) { self.config = config }

    func prepare() async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw StudioError("Tutorial Studio needs Screen Recording permission. Enable it in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.", code: "permission")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let filter: SCContentFilter
        let cfg = SCStreamConfiguration()
        var pixelW: Double
        var pixelH: Double
        switch config.mode {
        case "window":
            guard let w = content.windows.first(where: { $0.windowID == config.windowId }) else {
                throw StudioError("The selected window is no longer available.", code: "source-missing")
            }
            filter = SCContentFilter(desktopIndependentWindow: w)
            cfg.ignoreShadowsSingleWindow = true
            let scale = Double(filter.pointPixelScale)
            pixelW = Double(filter.contentRect.width) * scale
            pixelH = Double(filter.contentRect.height) * scale
        default:
            guard let d = content.displays.first(where: { $0.displayID == config.displayId }) ?? content.displays.first else {
                throw StudioError("No display available to record.", code: "source-missing")
            }
            let excluded = content.applications.filter { app in config.excludePid.map { app.processID == $0 } ?? false }
            filter = SCContentFilter(display: d, excludingApplications: excluded, exceptingWindows: [])
            let scale = Double(filter.pointPixelScale)
            if config.mode == "region", let r = config.region {
                let rect = CGRect(x: r.x, y: r.y, width: r.w, height: r.h).intersection(CGRect(x: 0, y: 0, width: Double(d.width), height: Double(d.height)))
                guard rect.width >= 16, rect.height >= 16 else { throw StudioError("The selected region is too small.", code: "region") }
                cfg.sourceRect = rect
                pixelW = rect.width * scale
                pixelH = rect.height * scale
            } else {
                pixelW = Double(d.width) * scale
                pixelH = Double(d.height) * scale
            }
        }
        width = even(pixelW)
        height = even(pixelH)
        cfg.width = width
        cfg.height = height
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(config.fps))
        cfg.showsCursor = config.showCursor
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.queueDepth = 8
        cfg.scalesToFit = true
        cfg.capturesAudio = false

        finalURL = URL(fileURLWithPath: config.output)
        try FileManager.default.createDirectory(at: finalURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        tmpURL = finalURL.deletingLastPathComponent().appendingPathComponent(".\(finalURL.deletingPathExtension().lastPathComponent).recording.mp4")
        try? FileManager.default.removeItem(at: tmpURL)
        writer = try AVAssetWriter(outputURL: tmpURL, fileType: .mp4)
        // H.264 hardware encoders top out around 4096×2304; use HEVC beyond that.
        let useHEVC = width > 4096 || height > 2304
        let pixelsPerSecond = Double(width * height * config.fps)
        let bitrate = Int(min(90_000_000, max(8_000_000, pixelsPerSecond * 0.09)))
        let settings: [String: Any] = [
            AVVideoCodecKey: useHEVC ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoExpectedSourceFrameRateKey: config.fps,
                AVVideoMaxKeyFrameIntervalKey: config.fps * 2,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        guard writer.startWriting() else { throw StudioError("Cannot create recording file: \(writer.error?.localizedDescription ?? "")", code: "writer") }

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
        IO.event("ready", ["width": width, "height": height, "codec": useHEVC ? "hevc" : "h264"])
    }

    func beginWriting() {
        queue.async { self.writing = true }
        IO.event("started")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, writing, sb.isValid else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if sessionStart == nil {
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
        }
        guard CMTimeCompare(pts, lastPTS) > 0 || frames == 0 else { return }
        if input.isReadyForMoreMediaData {
            if adaptor.append(pb, withPresentationTime: pts) {
                frames += 1
                lastPTS = pts
                lastBuffer = pb
            } else if failed == nil {
                failed = writer.error?.localizedDescription ?? "unknown writer error"
            }
        }
        let now = Date()
        if now.timeIntervalSince(lastProgress) > 0.5, let s0 = sessionStart {
            lastProgress = now
            IO.progress(["seconds": CMTimeGetSeconds(CMTimeSubtract(pts, s0)), "frames": frames])
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        IO.error("Recording stopped: \(error.localizedDescription)", code: "stream")
        queue.async { self.writing = false }
    }

    func stop(cancel: Bool) async {
        let stopTime = CMClockGetTime(CMClockGetHostTimeClock())
        queue.sync { writing = false }
        try? await stream?.stopCapture()
        IO.event("finalizing")
        if cancel || sessionStart == nil {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: tmpURL)
            if cancel { IO.event("cancelled"); exit(0) }
            IO.fail("No frames were captured. Make sure the selected window is visible and not minimized.", code: "empty")
        }
        // Hold the last frame until the stop moment so the file's duration matches the recording.
        queue.sync {
            if let last = lastBuffer, CMTimeCompare(stopTime, lastPTS) > 0, input.isReadyForMoreMediaData {
                if adaptor.append(last, withPresentationTime: stopTime) { lastPTS = stopTime }
            }
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: tmpURL)
            IO.fail("Could not finalize the recording: \(writer.error?.localizedDescription ?? failed ?? "unknown")", code: "writer")
        }
        do {
            try? FileManager.default.removeItem(at: finalURL)
            try FileManager.default.moveItem(at: tmpURL, to: finalURL)
        } catch {
            IO.fail("Could not save the recording: \(error.localizedDescription)", code: "writer")
        }
        let duration = CMTimeGetSeconds(CMTimeSubtract(lastPTS, sessionStart!))
        var result: [String: Any] = ["path": finalURL.path, "frames": frames, "duration": duration, "width": width, "height": height]
        if config.selfTest == true, config.mode == "display" { result["selfTest"] = await cursorSelfTest(video: finalURL, displayId: config.displayId) }
        IO.result(result)
        exit(0)
    }
}

/// Compares the recording's last frame with screenshots taken with and without the
/// system cursor, in the region where the cursor currently is.
func cursorSelfTest(video: URL, displayId: UInt32?) async -> [String: Any] {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let d = content.displays.first(where: { $0.displayID == displayId }) ?? content.displays.first else { return ["error": "no display"] }
        let filter = SCContentFilter(display: d, excludingApplications: [], exceptingWindows: [])
        let scale = Double(filter.pointPixelScale)
        func shot(_ cursor: Bool) async throws -> CGImage {
            let c = SCStreamConfiguration()
            c.width = Int(Double(d.width) * scale); c.height = Int(Double(d.height) * scale); c.showsCursor = cursor
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: c)
        }
        let withCursor = try await shot(true)
        let without = try await shot(false)
        let gen = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
        let dur = try await AVURLAsset(url: video).load(.duration)
        let (frame, _) = try await gen.image(at: CMTimeSubtract(dur, CMTime(value: 1, timescale: 60)))
        let loc = CGEvent(source: nil)?.location ?? .zero // global points, top-left origin
        let px = (loc.x - d.frame.minX) * scale, py = (loc.y - d.frame.minY) * scale
        let region = CGRect(x: px - 4, y: py - 4, width: 40 * scale, height: 48 * scale).integral
        func pixels(_ img: CGImage) -> [UInt8] {
            let w = Int(region.width), h = Int(region.height)
            var buf = [UInt8](repeating: 0, count: w * h * 4)
            let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            let sx = CGFloat(img.width) / CGFloat(withCursor.width)
            ctx.translateBy(x: -region.minX * sx, y: -(CGFloat(img.height) - (region.maxY) * sx))
            ctx.scaleBy(x: sx, y: sx)
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: CGFloat(img.width) / sx, height: CGFloat(img.height) / sx))
            return buf
        }
        func diff(_ a: [UInt8], _ b: [UInt8]) -> Double {
            var s = 0.0
            for i in stride(from: 0, to: min(a.count, b.count), by: 4) { s += Double(abs(Int(a[i]) - Int(b[i])) + abs(Int(a[i+1]) - Int(b[i+1])) + abs(Int(a[i+2]) - Int(b[i+2]))) / 3 }
            return s / Double(a.count / 4)
        }
        let pw = pixels(withCursor), pn = pixels(without), pr = pixels(frame)
        let cursorVisibleInScreenshots = diff(pw, pn) > 2
        let dNo = diff(pr, pn), dWith = diff(pr, pw)
        return ["cursorPoint": [loc.x, loc.y], "screenshotCursorDelta": diff(pw, pn), "recordingVsNoCursor": dNo, "recordingVsWithCursor": dWith,
                "conclusive": cursorVisibleInScreenshots, "cursorAbsent": cursorVisibleInScreenshots ? dNo < dWith : NSNull(),
                "frameWidth": frame.width, "frameHeight": frame.height]
    } catch {
        return ["error": error.localizedDescription]
    }
}

func runMain() async {
    let a = CommandLine.arguments
    do {
        switch a.count > 1 ? a[1] : "" {
        case "permission":
            IO.result(["status": permissionStatus()])
            exit(0)
        case "request-permission":
            let ok = CGRequestScreenCaptureAccess()
            IO.result(["status": ok ? "granted" : "denied"])
            exit(0)
        case "list":
            guard a.count >= 3 else { IO.fail("list <thumbDir> [excludePid]") }
            try await listSources(thumbDir: a[2], excludePid: a.count > 3 ? Int32(a[3]) : nil)
            exit(0)
        case "record":
            guard a.count >= 3, let data = a[2].data(using: .utf8) else { IO.fail("record <configJSON>") }
            let cfg = try JSONDecoder().decode(RecordConfig.self, from: data)
            let rec = Recorder(config: cfg)
            try await rec.prepare()
            IO.readCommands { cmd in
                switch cmd {
                case "start": rec.beginWriting()
                case "stop": Task { await rec.stop(cancel: false) }
                case "cancel", "eof": Task { await rec.stop(cancel: true) }
                default: IO.log("unknown command \(cmd)")
                }
            }
        default:
            IO.fail("usage: studio-recorder permission|request-permission|list|record")
        }
    } catch let e as StudioError {
        IO.fail(e.message, code: e.code)
    } catch {
        let ns = error as NSError
        if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.userDeclined.rawValue {
            IO.fail("Screen Recording permission was declined.", code: "permission")
        }
        IO.fail(error.localizedDescription)
    }
}

Task { await runMain() }
dispatchMain()
