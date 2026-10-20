// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "StudioNative",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "StudioNative", path: "Sources/StudioNative"),
        .executableTarget(name: "studio-render", dependencies: ["StudioNative"], path: "Sources/studio-render"),
        .executableTarget(name: "studio-recorder", dependencies: ["StudioNative"], path: "Sources/studio-recorder"),
        // Development-only: generates deterministic test media (not packaged).
        .executableTarget(name: "studio-fixtures", dependencies: ["StudioNative"], path: "Sources/studio-fixtures"),
    ]
)
