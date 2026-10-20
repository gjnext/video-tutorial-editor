// Generates build/icon.icns (original artwork): graphite tile, violet screen, white arrow.
import AppKit
import CoreGraphics

func render(_ size: Int) -> CGImage {
    let s = CGFloat(size)
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: s); ctx.scaleBy(x: 1, y: -1)
    let inset = s * 0.09
    let tile = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let tilePath = CGPath(roundedRect: tile, cornerWidth: s * 0.19, cornerHeight: s * 0.19, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: CGColor(gray: 0, alpha: 0.45))
    ctx.addPath(tilePath); ctx.setFillColor(CGColor(red: 0.11, green: 0.115, blue: 0.135, alpha: 1)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState(); ctx.addPath(tilePath); ctx.clip()
    let g = CGGradient(colorsSpace: cs, colors: [CGColor(red: 0.17, green: 0.18, blue: 0.21, alpha: 1), CGColor(red: 0.09, green: 0.095, blue: 0.11, alpha: 1)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: tile.minY), end: CGPoint(x: 0, y: tile.maxY), options: [])
    // Screen
    let scr = CGRect(x: tile.minX + s * 0.12, y: tile.minY + s * 0.17, width: tile.width - s * 0.24, height: tile.width * 0.5)
    let scrPath = CGPath(roundedRect: scr, cornerWidth: s * 0.035, cornerHeight: s * 0.035, transform: nil)
    ctx.saveGState(); ctx.addPath(scrPath); ctx.clip()
    let vg = CGGradient(colorsSpace: cs, colors: [CGColor(red: 0.33, green: 0.38, blue: 0.98, alpha: 1), CGColor(red: 0.67, green: 0.45, blue: 0.96, alpha: 1)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(vg, start: CGPoint(x: scr.minX, y: scr.minY), end: CGPoint(x: scr.maxX, y: scr.maxY), options: [])
    ctx.setFillColor(CGColor(gray: 1, alpha: 0.9))
    ctx.fill(CGRect(x: scr.minX + scr.width * 0.08, y: scr.minY + scr.height * 0.14, width: scr.width * 0.84, height: scr.height * 0.72).insetBy(dx: 0, dy: 0))
    ctx.setFillColor(CGColor(red: 0.16, green: 0.18, blue: 0.27, alpha: 1))
    ctx.fill(CGRect(x: scr.minX + scr.width * 0.08, y: scr.minY + scr.height * 0.14, width: scr.width * 0.2, height: scr.height * 0.72))
    ctx.restoreGState()
    // Path dots
    ctx.setStrokeColor(CGColor(red: 0.23, green: 0.82, blue: 0.74, alpha: 1)); ctx.setLineWidth(s * 0.012); ctx.setLineDash(phase: 0, lengths: [s * 0.025, s * 0.018])
    ctx.move(to: CGPoint(x: s * 0.3, y: s * 0.62)); ctx.addQuadCurve(to: CGPoint(x: s * 0.6, y: s * 0.66), control: CGPoint(x: s * 0.42, y: s * 0.8)); ctx.strokePath()
    ctx.setLineDash(phase: 0, lengths: [])
    ctx.setFillColor(CGColor(red: 0.23, green: 0.82, blue: 0.74, alpha: 1)); ctx.fillEllipse(in: CGRect(x: s * 0.27, y: s * 0.59, width: s * 0.06, height: s * 0.06))
    // Arrow cursor (same geometry as the app's cursor art)
    let k = s * 0.0155
    let ox = s * 0.6, oy = s * 0.5
    let pts: [(CGFloat, CGFloat)] = [(0, 0), (0, 17.2), (4.1, 13.3), (6.8, 19.6), (9.6, 18.4), (6.95, 12.3), (12.4, 12.3)]
    let arrow = CGMutablePath()
    arrow.move(to: CGPoint(x: ox + pts[0].0 * k, y: oy + pts[0].1 * k))
    for p in pts.dropFirst() { arrow.addLine(to: CGPoint(x: ox + p.0 * k, y: oy + p.1 * k)) }
    arrow.closeSubpath()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.01), blur: s * 0.025, color: CGColor(gray: 0, alpha: 0.5))
    ctx.addPath(arrow); ctx.setStrokeColor(CGColor(gray: 0.07, alpha: 1)); ctx.setLineWidth(2.6 * k); ctx.setLineJoin(.round); ctx.strokePath()
    ctx.setShadow(offset: .zero, blur: 0, color: nil)
    ctx.addPath(arrow); ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fillPath()
    ctx.restoreGState()
    return ctx.makeImage()!
}

let out = CommandLine.arguments[1]
let iconset = out.replacingOccurrences(of: ".icns", with: ".iconset")
try? FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for (name, size) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    let rep = NSBitmapImageRep(cgImage: render(size))
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(iconset)/icon_\(name).png"))
}
try! NSBitmapImageRep(cgImage: render(1024)).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out.replacingOccurrences(of: ".icns", with: ".png")))
