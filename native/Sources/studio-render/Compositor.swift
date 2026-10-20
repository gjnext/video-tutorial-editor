import CoreImage
import CoreImage.CIFilterBuiltins
import Metal
import StudioNative

/// Builds output frames from FrameDescriptions with Core Image (GPU).
///
/// Coordinates in the plan are top-left/y-down canvas pixels; Core Image is
/// bottom-left/y-up, so every rect is flipped with `ci(_:)`.
final class Compositor {
    let width: Int
    let height: Int
    let context: CIContext
    private var executor: OpExecutor
    private var background: CIImage?
    private var baseCache: (key: String, image: CIImage)?
    private var maskCache: (key: String, image: CIImage)?
    private let backgroundOps: [DrawOp]

    init(plan: RenderPlan) {
        width = plan.output.width
        height = plan.output.height
        let device = MTLCreateSystemDefaultDevice()
        let opts: [CIContextOption: Any] = [
            // Non-linear sRGB working space matches browser canvas blending.
            .workingColorSpace: sRGB,
            .workingFormat: CIFormat.RGBAh,
            .cacheIntermediates: false,
        ]
        context = device.map { CIContext(mtlDevice: $0, options: opts) } ?? CIContext(options: opts)
        var paths: [String: String] = [:]
        for a in plan.assets { paths[a.id] = a.path }
        executor = OpExecutor(themes: plan.cursorThemes, assetPaths: paths, images: ImageCache())
        backgroundOps = plan.background
    }

    private func ci(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: CGFloat(height) - r.maxY, width: r.width, height: r.height)
    }

    private func backgroundImage() -> CIImage {
        if let b = background { return b }
        let ctx = makeTopLeftContext(width: width, height: height)!
        let size = CGSize(width: width, height: height)
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(origin: .zero, size: size))
        for op in backgroundOps { executor.run(op, in: ctx, canvas: size) }
        let img = CIImage(cgImage: ctx.makeImage()!)
        background = img
        return img
    }

    private func roundedMask(dest: CGRect, radius: CGFloat) -> CIImage {
        let key = "\(dest)|\(radius)"
        if let m = maskCache, m.key == key { return m.image }
        let ctx = makeTopLeftContext(width: width, height: height)!
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.addPath(CGPath(roundedRect: dest, cornerWidth: radius, cornerHeight: radius, transform: nil))
        ctx.fillPath()
        let img = CIImage(cgImage: ctx.makeImage()!)
        maskCache = (key, img)
        return img
    }

    /// Background + video shadow; static while the placement is unchanged.
    private func baseImage(_ v: VideoDraw?) -> CIImage {
        let bg = backgroundImage()
        guard let v, let sh = v.shadow, sh.color.count >= 4, sh.color[3] > 0 else { return bg }
        let key = "\(v.dest)|\(v.radius)|\(sh)"
        if let b = baseCache, b.key == key { return b.image }
        // Shadow = rounded rect in the shadow color, offset, Gaussian σ = blur/2 (canvas semantics).
        let rect = v.dest.cg.offsetBy(dx: sh.offsetX, dy: sh.offsetY)
        let ctx = makeTopLeftContext(width: width, height: height)!
        ctx.setFillColor(cgColor(sh.color)!)
        ctx.addPath(CGPath(roundedRect: rect, cornerWidth: v.radius, cornerHeight: v.radius, transform: nil))
        ctx.fillPath()
        var shadow = CIImage(cgImage: ctx.makeImage()!)
        if sh.blur > 0.01 {
            shadow = shadow.clampedToExtent().applyingGaussianBlur(sigma: sh.blur / 2).cropped(to: bg.extent)
        }
        let composed = shadow.composited(over: bg)
        // Rasterize once so the blur is not recomputed every frame.
        let cg = context.createCGImage(composed, from: bg.extent, format: .RGBA8, colorSpace: sRGB)!
        let img = CIImage(cgImage: cg)
        baseCache = (key, img)
        return img
    }

    func compose(_ f: FrameDescription, sources: [String: VideoFrameSource]) throws -> CIImage {
        var out = baseImage(f.video)
        if let v = f.video, let src = sources[v.assetId], let pb = try src.frame(atFlicks: v.sourceTime) {
            let frame = src.orientedImage(pb)
            let fh = frame.extent.height
            // Source rect (top-left) → CI coordinates of the decoded frame.
            let srcCI = CGRect(x: v.src.x, y: fh - v.src.y - v.src.h, width: v.src.w, height: v.src.h)
            let dest = ci(v.dest.cg)
            let sx = dest.width / srcCI.width
            let sy = dest.height / srcCI.height
            var img = frame.clampedToExtent()
                .transformed(by: CGAffineTransform(translationX: -srcCI.minX, y: -srcCI.minY))
            if abs(sx - 1) > 1e-6 || abs(sy - 1) > 1e-6 {
                let lanczos = CIFilter.lanczosScaleTransform()
                lanczos.inputImage = img
                lanczos.scale = Float(sy)
                lanczos.aspectRatio = Float(sx / sy)
                img = lanczos.outputImage ?? img
            }
            img = img.transformed(by: CGAffineTransform(translationX: dest.minX, y: dest.minY)).cropped(to: dest)
            let mask = roundedMask(dest: v.dest.cg, radius: CGFloat(v.radius))
            img = img.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: out, kCIInputMaskImageKey: mask])
            out = img.cropped(to: out.extent)
        }
        if let hl = f.highlights, !hl.isEmpty, let img = layerImage(hl, clip: f.highlightClip) {
            out = img.composited(over: out)
        }
        if !f.overlay.isEmpty, let overlay = layerImage(f.overlay, clip: f.overlayClip) {
            out = overlay.composited(over: out)
        }
        return out
    }

    /// Draw ops (highlights, cursor, effects) into a small bitmap covering only their bounds.
    private func layerImage(_ ops: [DrawOp], clip: ClipRect?) -> CIImage? {
        var bounds = CGRect.null
        for op in ops { bounds = bounds.union(executor.bounds(op)) }
        bounds = bounds.intersection(CGRect(x: 0, y: 0, width: width, height: height))
        if let c = clip { bounds = bounds.intersection(CGRect(x: c.x, y: c.y, width: c.w, height: c.h)) }
        if bounds.isNull || bounds.isEmpty { return nil }
        bounds = bounds.integral
        guard let ctx = makeTopLeftContext(width: Int(bounds.width), height: Int(bounds.height)) else { return nil }
        ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
        if let c = clip {
            ctx.addPath(CGPath(roundedRect: CGRect(x: c.x, y: c.y, width: c.w, height: c.h), cornerWidth: c.radius, cornerHeight: c.radius, transform: nil))
            ctx.clip()
        }
        let size = CGSize(width: width, height: height)
        for op in ops { executor.run(op, in: ctx, canvas: size) }
        guard let cg = ctx.makeImage() else { return nil }
        return CIImage(cgImage: cg).transformed(by: CGAffineTransform(translationX: bounds.minX, y: CGFloat(height) - bounds.maxY))
    }
}
