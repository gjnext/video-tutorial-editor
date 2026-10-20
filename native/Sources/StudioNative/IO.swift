import Foundation

/// NDJSON protocol shared by all helpers: one JSON object per line on stdout.
/// stderr is reserved for diagnostics. See shared/ipc.ts (HelperMessage).
public enum IO {
    private static let lock = NSLock()

    public static func emit(_ object: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }

    public static func result(_ fields: [String: Any]) {
        var o = fields
        o["type"] = "result"
        emit(o)
    }

    public static func event(_ name: String, _ fields: [String: Any] = [:]) {
        var o = fields
        o["type"] = "event"
        o["event"] = name
        emit(o)
    }

    public static func progress(_ fields: [String: Any]) {
        var o = fields
        o["type"] = "progress"
        emit(o)
    }

    public static func error(_ message: String, code: String? = nil) {
        var o: [String: Any] = ["type": "error", "message": message]
        if let code { o["code"] = code }
        emit(o)
    }

    public static func log(_ message: String) {
        FileHandle.standardError.write("[native] \(message)\n".data(using: .utf8)!)
    }

    /// Read newline-delimited commands from stdin on a background thread.
    /// EOF on stdin (parent died) is delivered as "eof".
    public static func readCommands(_ handler: @escaping (String) -> Void) {
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { handler(trimmed) }
            }
            handler("eof")
        }
    }

    public static func fail(_ message: String, code: String? = nil) -> Never {
        error(message, code: code)
        exit(1)
    }
}

public struct StudioError: Error, CustomStringConvertible {
    public let message: String
    public let code: String?
    public init(_ message: String, code: String? = nil) {
        self.message = message
        self.code = code
    }
    public var description: String { message }
}

/// Project time unit shared with TypeScript (shared/time.ts).
public let FLICKS_PER_SECOND: Int64 = 705_600_000

import CoreMedia

public extension CMTime {
    init(flicks: Int64) {
        self = CMTime(value: flicks, timescale: CMTimeScale(FLICKS_PER_SECOND))
    }
}
