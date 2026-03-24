import Foundation
import Vision
import ImageIO

struct OcrResult: Codable {
  let path: String
  let text: String?
  let error: String?
}

func recognizeText(at path: String) -> OcrResult {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
    return OcrResult(path: path, text: nil, error: "Could not open image.")
  }
  guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    return OcrResult(path: path, text: nil, error: "Could not decode image.")
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true

  do {
    let handler = VNImageRequestHandler(cgImage: image)
    try handler.perform([request])
    let observations = request.results ?? []
    let text = observations
      .compactMap { $0.topCandidates(1).first?.string }
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      .joined(separator: "\n")
    return OcrResult(path: path, text: text.isEmpty ? nil : text, error: nil)
  } catch {
    return OcrResult(path: path, text: nil, error: error.localizedDescription)
  }
}

let paths = Array(CommandLine.arguments.dropFirst())
let results = paths.map(recognizeText)
let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]

do {
  let data = try encoder.encode(results)
  if let output = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write(output.data(using: .utf8)!)
  }
} catch {
  FileHandle.standardError.write("Failed to encode OCR results.\n".data(using: .utf8)!)
  exit(1)
}
