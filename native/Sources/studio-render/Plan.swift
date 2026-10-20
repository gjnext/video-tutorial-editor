import Foundation

/// Mirror of shared/renderPlan.ts. The renderer executes this plan; it does not
/// re-derive timing, layout or cursor motion.
struct RenderPlan: Decodable {
    let version: Int
    let output: Output
    let duration: Int64
    let frameCount: Int
    let assets: [Asset]
    let background: [DrawOp]
    let cursorThemes: [String: CursorTheme]
    let audio: [AudioPlacement]
    let frames: [FrameDescription]

    struct Output: Decodable {
        let path: String
        let width: Int
        let height: Int
        let fpsNum: Int32
        let fpsDen: Int64
        let codec: String
        let videoBitrate: Int
        let audioBitrate: Int
        let sampleRate: Int
        let keyframeIntervalFrames: Int
    }

    struct Asset: Decodable {
        let id: String
        let kind: String
        let path: String
        let width: Double
        let height: Double
    }
}

struct RectD: Decodable, Hashable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    var cg: CGRect { CGRect(x: x, y: y, width: w, height: h) }
}

struct GradientStop: Decodable {
    let pos: Double
    let color: [Double]
}

struct ShadowOp: Decodable, Hashable {
    let blur: Double
    let offsetX: Double
    let offsetY: Double
    let color: [Double]
}

struct DrawOp: Decodable {
    let op: String
    // fill / circle / line
    var color: [Double]?
    var fill: [Double]?
    var stroke: [Double]?
    var lineWidth: Double?
    // gradients
    var x0: Double?, y0: Double?, x1: Double?, y1: Double?
    var cx: Double?, cy: Double?, r: Double?
    var stops: [GradientStop]?
    // image
    var assetId: String?
    var src: RectD?
    var dest: RectD?
    // cursor
    var theme: String?
    var x: Double?, y: Double?
    var scale: Double?
    var alpha: Double?
    var shadow: Bool?
}

struct ClipRect: Decodable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let radius: Double
}

struct VideoDraw: Decodable {
    let assetId: String
    let sourceTime: Int64
    let frozen: Bool
    let src: RectD
    let dest: RectD
    let radius: Double
    let shadow: ShadowOp?
}

struct FrameDescription: Decodable {
    let t: Int64
    let video: VideoDraw?
    let overlay: [DrawOp]
    let overlayClip: ClipRect?
}

struct CursorTheme: Decodable {
    struct Layer: Decodable {
        let d: String
        let fill: [Double]?
        let stroke: [Double]?
        let lineWidth: Double?
    }
    let layers: [Layer]
    let shadow: ShadowOp
}

struct AudioPlacement: Decodable {
    let id: String
    let assetId: String
    let path: String
    let start: Int64
    let sourceIn: Int64
    let sourceOut: Int64
    let gain: Double
    let fadeIn: Int64
    let fadeOut: Int64
}

func loadPlan(_ path: String) throws -> RenderPlan {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    do {
        return try JSONDecoder().decode(RenderPlan.self, from: data)
    } catch {
        throw StudioErrorLocal("Invalid render plan: \(error)")
    }
}

struct StudioErrorLocal: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}
