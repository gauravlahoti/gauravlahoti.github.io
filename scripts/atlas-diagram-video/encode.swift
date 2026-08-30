// Encode a PNG frame sequence to H.264 MP4 using AVFoundation.
//
// This exists instead of an ffmpeg call because ffmpeg (and Homebrew) are not
// installed on this machine, while Swift and AVFoundation ship with macOS.
// Output is H.264 / yuv420p in an MP4 container, which is what LinkedIn wants.
//
// Usage:
//   swift encode.swift <frames-dir> <out.mp4> <fps> <loops>
//
// <loops> repeats the whole sequence N times in the output (1 = play once).

import AVFoundation
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 5,
      let fps = Int32(args[3]),
      let loops = Int(args[4]), loops >= 1 else {
    FileHandle.standardError.write("usage: encode.swift <frames-dir> <out.mp4> <fps> <loops>\n".data(using: .utf8)!)
    exit(2)
}
let framesDir = args[1]
let outURL = URL(fileURLWithPath: args[2])

let files = try FileManager.default
    .contentsOfDirectory(atPath: framesDir)
    .filter { $0.hasSuffix(".png") }
    .sorted()
guard !files.isEmpty else {
    FileHandle.standardError.write("no PNG frames in \(framesDir)\n".data(using: .utf8)!)
    exit(1)
}

// Size is taken from the first frame so the encoder never disagrees with the
// renderer about dimensions.
guard let firstImage = NSImage(contentsOfFile: "\(framesDir)/\(files[0])"),
      let firstCG = firstImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read first frame\n".data(using: .utf8)!)
    exit(1)
}
let width = firstCG.width
let height = firstCG.height

try? FileManager.default.removeItem(at: outURL)

let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        // High bitrate: the source is flat dark UI with thin cyan strokes,
        // which is exactly what shows blocking artifacts when starved.
        AVVideoAverageBitRateKey: 12_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: fps,   // a keyframe every second
        AVVideoAllowFrameReorderingKey: true,
    ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false

let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32ARGB),
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
    ]
)
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func pixelBuffer(from cg: CGImage) -> CVPixelBuffer? {
    var pb: CVPixelBuffer?
    let attrs: [String: Any] = [
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                              kCVPixelFormatType_32ARGB, attrs as CFDictionary, &pb) == kCVReturnSuccess,
          let buffer = pb else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let ctx = CGContext(
        data: CVPixelBufferGetBaseAddress(buffer),
        width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
    ) else { return nil }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    return buffer
}

var frameIndex: Int64 = 0
var encoded = 0
for _ in 0..<loops {
    for name in files {
        guard let img = NSImage(contentsOfFile: "\(framesDir)/\(name)"),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let buf = pixelBuffer(from: cg) else {
            FileHandle.standardError.write("skipped unreadable frame \(name)\n".data(using: .utf8)!)
            continue
        }
        while !input.isReadyForMoreMediaData { usleep(2000) }
        adaptor.append(buf, withPresentationTime: CMTime(value: frameIndex, timescale: fps))
        frameIndex += 1
        encoded += 1
    }
}

input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()

if writer.status == .completed {
    let bytes = (try? FileManager.default.attributesOfItem(atPath: outURL.path)[.size] as? Int) ?? 0
    let secs = Double(encoded) / Double(fps)
    print(String(format: "wrote %@  %dx%d  %d frames  %.2fs  %.2f MB",
                 outURL.lastPathComponent, width, height, encoded, secs,
                 Double(bytes) / 1_048_576))
} else {
    FileHandle.standardError.write("encode failed: \(writer.error?.localizedDescription ?? "unknown")\n".data(using: .utf8)!)
    exit(1)
}
