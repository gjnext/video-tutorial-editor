import CoreGraphics
import Foundation
import ImageIO

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func cgColor(_ c: [Double]?, alphaMul: Double = 1) -> CGColor? {
    guard let c, c.count >= 3 else { return nil }
    let a = (c.count > 3 ? c[3] : 1) * alphaMul
    return CGColor(colorSpace: sRGB, components: [c[0], c[1], c[2], a])
}

/// Parser for the absolute M/L/C/Z path subset used by shared/cursorThemes.ts.
func parseSVGPath(_ d: String) -> CGPath {
    let path = CGMutablePath()
    var tokens: [String] = []
    var cur = ""
    for ch in d {
        if "MLCZmlcz".contains(ch) {
            if !cur.isEmpty { tokens.append(cur); cur = "" }
            tokens.append(String(ch))
        } else if ch == " " || ch == "," {
            if !cur.isEmpty { tokens.append(cur); cur = "" }
        } else {
            cur.append(ch)
        }
    }
    if !cur.isEmpty { tokens.append(cur) }
    var i = 0
    var cmd = "M"
    func num() -> CGFloat { defer { i += 1 }; return CGFloat(Double(tokens[i]) ?? 0) }
    while i < tokens.count {
        let t = tokens[i]
        if "MLCZ".contains(t) { cmd = t; i += 1; if t == "Z" { path.closeSubpath() }; continue }
        switch cmd {
        case "M": path.move(to: CGPoint(x: num(), y: num())); cmd = "L"
        case "L": path.addLine(to: CGPoint(x: num(), y: num()))
        case "C":
            let c1 = CGPoint(x: num(), y: num()), c2 = CGPoint(x: num(), y: num()), p = CGPoint(x: num(), y: num())
            path.addCurve(to: p, control1: c1, control2: c2)
        default: i += 1
        }
    }
    return path
}

/// Creates a premultiplied sRGB bitmap context whose user space is top-left origin, +y down.
func makeTopLeftContext(width: Int, height: Int) -> CGContext? {
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1, y: -1)
    ctx.setShouldAntialias(true)
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high
    return ctx
}

final class ImageCache {
    private var images: [String: CGImage] = [:]
    func image(at path: String) -> CGImage? {
        if let i = images[path] { return i }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
        images[path] = img
        return img
    }
}

/// Executes DrawOps (shared/drawOps.ts) in a top-left CG context.
struct OpExecutor {
    let themes: [String: CursorTheme]
    let assetPaths: [String: String]
    let images: ImageCache
    private var pathCache: [String: CGPath] = [:]

    init(themes: [String: CursorTheme], assetPaths: [String: String], images: ImageCache) {
        self.themes = themes
        self.assetPaths = assetPaths
        self.images = images
    }

    mutating func cursorPath(_ d: String) -> CGPath {
        if let p = pathCache[d] { return p }
        let p = parseSVGPath(d)
        pathCache[d] = p
        return p
    }

    mutating func run(_ op: DrawOp, in ctx: CGContext, canvas: CGSize) {
        let full = CGRect(origin: .zero, size: canvas)
        switch op.op {
        case "fill":
            if let c = cgColor(op.color) { ctx.setFillColor(c); ctx.fill(full) }
        case "linear":
            guard let g = gradient(op.stops) else { return }
            ctx.saveGState()
            ctx.clip(to: full)
            ctx.drawLinearGradient(g, start: CGPoint(x: op.x0 ?? 0, y: op.y0 ?? 0), end: CGPoint(x: op.x1 ?? 0, y: op.y1 ?? 0),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            ctx.restoreGState()
        case "radial":
            guard let g = gradient(op.stops) else { return }
            let c = CGPoint(x: op.cx ?? 0, y: op.cy ?? 0)
            ctx.saveGState()
            ctx.clip(to: full)
            ctx.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: CGFloat(op.r ?? 0), options: [.drawsAfterEndLocation])
            ctx.restoreGState()
        case "circle":
            let r = op.r ?? 0
            let rect = CGRect(x: (op.cx ?? 0) - r, y: (op.cy ?? 0) - r, width: 2 * r, height: 2 * r)
            if let f = cgColor(op.fill) { ctx.setFillColor(f); ctx.fillEllipse(in: rect) }
            if let s = cgColor(op.stroke) { ctx.setStrokeColor(s); ctx.setLineWidth(CGFloat(op.lineWidth ?? 1)); ctx.strokeEllipse(in: rect) }
        case "line":
            if let s = cgColor(op.stroke) {
                ctx.setStrokeColor(s)
                ctx.setLineWidth(CGFloat(op.lineWidth ?? 1))
                ctx.setLineCap(.butt)
                ctx.strokeLineSegments(between: [CGPoint(x: op.x0 ?? 0, y: op.y0 ?? 0), CGPoint(x: op.x1 ?? 0, y: op.y1 ?? 0)])
            }
        case "image":
            guard let id = op.assetId, let path = assetPaths[id], let img = images.image(at: path), let src = op.src, let dest = op.dest else { return }
            // Map the source rect onto dest: draw the whole image scaled, clipped to dest.
            let sx = dest.w / src.w, sy = dest.h / src.h
            let drawRect = CGRect(x: dest.x - src.x * sx, y: dest.y - src.y * sy, width: Double(img.width) * sx, height: Double(img.height) * sy)
            ctx.saveGState()
            ctx.clip(to: dest.cg)
            // Context is flipped; flip the image back locally.
            ctx.translateBy(x: drawRect.minX, y: drawRect.maxY)
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(img, in: CGRect(origin: .zero, size: drawRect.size))
            ctx.restoreGState()
        case "cursor":
            drawCursor(op, in: ctx)
        default:
            break
        }
    }

    mutating func drawCursor(_ op: DrawOp, in ctx: CGContext) {
        guard let theme = themes[op.theme ?? "macos"] ?? themes["macos"] else { return }
        let s = CGFloat(op.scale ?? 1)
        ctx.saveGState()
        ctx.setAlpha(CGFloat(op.alpha ?? 1))
        if op.shadow ?? true, let sc = cgColor(theme.shadow.color) {
            // Shadow offsets are in device space (y up); our user space is flipped.
            ctx.setShadow(offset: CGSize(width: theme.shadow.offsetX * Double(s), height: -theme.shadow.offsetY * Double(s)),
                          blur: CGFloat(theme.shadow.blur) * s, color: sc)
        }
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.translateBy(x: CGFloat(op.x ?? 0), y: CGFloat(op.y ?? 0))
        ctx.scaleBy(x: s, y: s)
        ctx.setLineJoin(.round)
        ctx.setLineCap(.round)
        for layer in theme.layers {
            let p = cursorPath(layer.d)
            if let st = cgColor(layer.stroke) {
                ctx.addPath(p)
                ctx.setStrokeColor(st)
                ctx.setLineWidth(CGFloat(layer.lineWidth ?? 1))
                ctx.strokePath()
            }
            if let f = cgColor(layer.fill) {
                ctx.addPath(p)
                ctx.setFillColor(f)
                ctx.fillPath()
            }
        }
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }

    func gradient(_ stops: [GradientStop]?) -> CGGradient? {
        guard let stops, !stops.isEmpty else { return nil }
        var comps: [CGFloat] = []
        var locs: [CGFloat] = []
        for s in stops {
            let c = s.color
            comps += [c[0], c[1], c[2], c.count > 3 ? c[3] : 1].map { CGFloat($0) }
            locs.append(CGFloat(s.pos))
        }
        return CGGradient(colorSpace: sRGB, colorComponents: comps, locations: locs, count: stops.count)
    }

    /// Conservative bounding box of an overlay op, in canvas pixels.
    func bounds(_ op: DrawOp) -> CGRect {
        switch op.op {
        case "circle":
            let r = (op.r ?? 0) + (op.lineWidth ?? 0) + 2
            return CGRect(x: (op.cx ?? 0) - r, y: (op.cy ?? 0) - r, width: 2 * r, height: 2 * r)
        case "cursor":
            let s = op.scale ?? 1
            // Cursor art spans ~0..13 x 0..20 units; add stroke and shadow margins.
            return CGRect(x: (op.x ?? 0) - 8 * s, y: (op.y ?? 0) - 8 * s, width: 30 * s, height: 38 * s)
        default:
            return .null
        }
    }
}

