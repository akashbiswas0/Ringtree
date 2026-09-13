import AppKit

let width = 3840
let height = 2160
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
context.shouldAntialias = true
context.cgContext.scaleBy(x: CGFloat(width) / 1600, y: CGFloat(height) / 900)
let cream = NSColor(calibratedRed: 0.95, green: 0.95, blue: 0.91, alpha: 1)
let forest = NSColor(calibratedRed: 0.075, green: 0.16, blue: 0.13, alpha: 1)
let sage = NSColor(calibratedRed: 0.63, green: 0.76, blue: 0.62, alpha: 1)
func rectangle(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: NSColor) {
    color.setFill()
    NSBezierPath(rect: NSRect(x: x, y: y, width: w, height: h)).fill()
}
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, _ color: NSColor, bold: Bool = false) {
    let font = NSFont(name: bold ? "Arial-BoldMT" : "ArialMT", size: size)!
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: font, .foregroundColor: color])
}
func line(_ points: [NSPoint], _ color: NSColor, _ weight: CGFloat) {
    let path = NSBezierPath()
    path.move(to: points[0])
    for point in points.dropFirst() { path.line(to: point) }
    path.lineWidth = weight
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    color.setStroke()
    path.stroke()
}
func ring(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat, _ color: NSColor, _ weight: CGFloat) {
    let path = NSBezierPath(ovalIn: NSRect(x: x-radius, y: y-radius, width: radius*2, height: radius*2))
    path.lineWidth = weight
    color.setStroke()
    path.stroke()
}
rectangle(0, 0, 1600, 900, cream)
rectangle(900, 0, 700, 900, forest)
let subtle = sage.withAlphaComponent(0.14)
line([NSPoint(x: 1240, y: 220), NSPoint(x: 1240, y: 730), NSPoint(x: 1050, y: 730), NSPoint(x: 1050, y: 810)], subtle, 3)
line([NSPoint(x: 1240, y: 610), NSPoint(x: 1480, y: 610), NSPoint(x: 1480, y: 760)], subtle, 3)
ring(1050, 825, 15, subtle, 3)
ring(1480, 780, 20, subtle, 3)
let logo = NSBezierPath()
logo.move(to: NSPoint(x: 115, y: 814))
logo.curve(to: NSPoint(x: 88, y: 787), controlPoint1: NSPoint(x: 100.0883, y: 814), controlPoint2: NSPoint(x: 88, y: 801.9117))
logo.line(to: NSPoint(x: 88, y: 823))
logo.lineWidth = 5.4
logo.lineCapStyle = .round
logo.lineJoinStyle = .round
forest.setStroke()
logo.stroke()
ring(124, 814, 9, forest, 5.4)
ring(88, 778, 9, forest, 5.4)
text("RingTree", 154, 769, 53, forest, bold: true)
text("AGENTS ACT. YOU AUTHORIZE.", 80, 652, 23, forest)
text("Autonomy.", 74, 495, 100, forest, bold: true)
text("In your hands.", 74, 383, 100, forest, bold: true)
text("Ledger-rooted control for remote AI agents.", 80, 289, 31, forest)
text("Scoped permissions. Keys stay with you.", 80, 241, 28, forest.withAlphaComponent(0.7))
rectangle(80, 151, 730, 1, forest.withAlphaComponent(0.2))
text("HARDWARE TRUST", 80, 105, 18, forest, bold: true)
text("/", 282, 105, 18, forest.withAlphaComponent(0.4))
text("BOUNDED AUTONOMY", 308, 105, 18, forest, bold: true)
text("/", 552, 105, 18, forest.withAlphaComponent(0.4))
text("OWNER CONTROL", 578, 105, 18, forest, bold: true)
let photo = NSImage(contentsOfFile: "public/images/ledger-flex-hero.webp")!
photo.draw(in: NSRect(x: 752, y: -58, width: 1030, height: 826), from: .zero, operation: .sourceOver, fraction: 1)
text("POWERED BY YOUR APPROVAL", 954, 824, 19, sage)
NSGraphicsContext.restoreGraphicsState()
let destination = URL(fileURLWithPath: "output/cover/ringtree-cover-3840x2160.png")
try bitmap.representation(using: .png, properties: [:])!.write(to: destination)
print(destination.path)
