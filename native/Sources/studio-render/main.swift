import AVFoundation
import CoreImage
import Foundation
import StudioNative

/// studio-render — offline media services for Tutorial Studio.
///
///   probe <file>                                  → {type:result, kind, duration, width, height, ...}
///   thumbs <file> <outDir> <intervalSec> <height> → {type:result, files, ...}
///   export <plan.json>                            → progress lines, then {type:result, path, bytes}
///   render-frame <plan.json> <index> <out.png>    → render one planned frame (consistency tests)
///   extract-frame <video> <seconds> <out.png>     → exact decoded frame (verification)
///
/// Cancellation: write "cancel" to stdin, close stdin, or send SIGTERM.

func runMain() async {
    let args = CommandLine.arguments
    guard args.count >= 2 else { IO.fail("usage: studio-render <probe|thumbs|export|render-frame|extract-frame> ...") }
    do {
        switch args[1] {
        case "probe":
            guard args.count >= 3 else { IO.fail("probe <file>") }
            IO.result(try await Probe.run(path: args[2]))
        case "thumbs":
            guard args.count >= 6 else { IO.fail("thumbs <file> <outDir> <interval> <height>") }
            IO.result(try await Thumbnails.run(path: args[2], outDir: args[3], interval: Double(args[4]) ?? 2, height: Int(args[5]) ?? 64))
        case "export":
            guard args.count >= 3 else { IO.fail("export <plan.json>") }
            let plan = try loadPlan(args[2])
            let exporter = Exporter(plan: plan)
            IO.readCommands { cmd in if cmd == "cancel" || cmd == "eof" { exporter.cancel() } }
            signal(SIGTERM, SIG_IGN)
            let sig = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
            sig.setEventHandler { exporter.cancel() }
            sig.resume()
            try await exporter.run()
        case "render-frame":
            guard args.count >= 5, let index = Int(args[3]) else { IO.fail("render-frame <plan.json> <index> <out.png>") }
            let plan = try loadPlan(args[2])
            guard index >= 0 && index < plan.frames.count else { IO.fail("frame index out of range") }
            var sources: [String: VideoFrameSource] = [:]
            for a in plan.assets where a.kind == "video" { sources[a.id] = try await VideoFrameSource(path: a.path) }
            let comp = Compositor(plan: plan)
            let img = try comp.compose(plan.frames[index], sources: sources)
            guard let cg = comp.context.createCGImage(img, from: CGRect(x: 0, y: 0, width: plan.output.width, height: plan.output.height), format: .RGBA8, colorSpace: sRGB) else {
                IO.fail("render failed")
            }
            try Thumbnails.writePNG(cg, to: args[4])
            IO.result(["path": args[4]])
        case "extract-frame":
            guard args.count >= 5, let secs = Double(args[3]) else { IO.fail("extract-frame <video> <seconds> <out.png>") }
            let asset = AVURLAsset(url: URL(fileURLWithPath: args[2]))
            let gen = AVAssetImageGenerator(asset: asset)
            gen.appliesPreferredTrackTransform = true
            gen.requestedTimeToleranceBefore = .zero
            gen.requestedTimeToleranceAfter = .zero
            let (img, actual) = try await gen.image(at: CMTime(seconds: secs, preferredTimescale: 600000))
            try Thumbnails.writePNG(img, to: args[4])
            IO.result(["path": args[4], "actualTime": CMTimeGetSeconds(actual), "width": img.width, "height": img.height])
        default:
            IO.fail("unknown command \(args[1])")
        }
        exit(0)
    } catch let e as StudioError {
        IO.fail(e.message, code: e.code)
    } catch {
        IO.fail("\(error)")
    }
}

Task { await runMain() }
dispatchMain()
