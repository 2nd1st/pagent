// pagent-ax: one request on stdin (JSON), one answer on stdout (JSON). The macOS accessibility API for a running
// app: read its main window as a tree, act on an element, post keys to it, click it for real, find its window id
// (for a screenshot). Everything but click works on apps in the background: nothing is raised or focused.
//   {"op":"read","app":"Calculator","depth":40,"limit":800,"seconds":5}   (the defaults; past them, "truncated": true)
//   {"op":"act","app":"Calculator","label":"Equals","role":"Button","action":"press"}   or "id":"…", or "ref":"0.0.5"
//   {"op":"act","app":"Calculator","label":"Edit field","action":"set","value":"42"}   ("focus" sets AXFocused)
//   {"op":"key","app":"WeChat","key":"return","id":"chat_input_field"}   (focus the target first; or "text":"…")
//   {"op":"click","app":"WeChat","id":"session_item_…","restore":true}   (a real mouse click: brings the app front)
//   {"op":"window","app":"Calculator"}
//   {"op":"reopen","app":"WeChat","restore":true}   (show the main window again, as the Dock icon does: brings it front)
//   {"op":"launch","app":"Calculator"}   (start it without bringing it front, if it is not running; waits for its window)
//   {"op":"quit","app":"Calculator","pid":123}   (quit it, only if it is still the process with that pid)
//   {"op":"watch","app":"WeChat","id":"session_list"}   (long-lived: a JSON line per change, until killed; see watch)
import AppKit
import ApplicationServices

struct Fail: Error { let message: String }

func out(_ v: Any) {
  let data = try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else {
  out(["ok": false, "error": "bad request"]); exit(0)
}

func attrs(_ e: AXUIElement, _ names: [String]) -> [String: AnyObject] {
  var values: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(e, names as CFArray, [], &values) == .success,
        let vs = values as? [AnyObject] else { return [:] }
  var r: [String: AnyObject] = [:]
  for (n, v) in zip(names, vs) {
    // Missing attributes come back as AXValue errors; keep real values only.
    if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
    r[n] = v
  }
  return r
}

/// The running app by name or bundle id. Several can share a name (WeChat's helper "WeChatAppEx" is also called
/// "WeChat"): an exact bundle id wins, then a regular app that is not nested in another app's bundle, then one
/// with windows.
func app(_ name: String) throws -> NSRunningApplication {
  let all = NSWorkspace.shared.runningApplications.filter { $0.localizedName == name || $0.bundleIdentifier == name }
  func score(_ a: NSRunningApplication) -> Int {
    var s = 0
    if a.bundleIdentifier == name { s += 8 }
    if a.activationPolicy == .regular { s += 4 }
    if !(a.bundleURL?.deletingLastPathComponent().path.contains(".app") ?? false) { s += 2 }
    if let ws = attrs(AXUIElementCreateApplication(a.processIdentifier), ["AXWindows"])["AXWindows"] as? [AXUIElement], !ws.isEmpty { s += 1 }
    return s
  }
  if let a = all.max(by: { score($0) < score($1) }) { return a }
  throw Fail(message: "\(name) is not running")
}

func text(_ v: AnyObject?) -> String? {
  guard let v else { return nil }
  if let s = v as? String { return s.isEmpty ? nil : s.replacingOccurrences(of: "\u{200E}", with: "") }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func actionNames(_ e: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(e, &names) == .success, let a = names as? [String] else { return [] }
  // Only the standard ones: apps also list custom actions as long descriptions.
  let known = ["AXPress": "press", "AXIncrement": "increment", "AXDecrement": "decrement", "AXConfirm": "confirm",
               "AXCancel": "cancel", "AXPick": "pick", "AXRaise": "raise"]
  return a.compactMap { known[$0] }
}

func frame(_ e: AXUIElement) -> CGRect? {
  let r = attrs(e, ["AXPosition", "AXSize"])
  var p = CGPoint.zero, s = CGSize.zero
  guard let pv = r["AXPosition"], let sv = r["AXSize"],
        AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
  return CGRect(origin: p, size: s)
}

/// The app's main window: the largest standard window (of two the same size, the one with more children: WeChat's
/// browser window can sit exactly over its main window). AXWindows[0] is not it in every app (WeChat's first window
/// is an empty 30px strip above the real one), and the focused window can be a small dialog. Windows on another Space
/// are missing from AXWindows, so the main and focused windows are candidates too.
func window(_ a: NSRunningApplication) throws -> AXUIElement {
  let root = AXUIElementCreateApplication(a.processIdentifier)
  let r = attrs(root, ["AXWindows", "AXMainWindow", "AXFocusedWindow"])
  var all = (r["AXWindows"] as? [AXUIElement]) ?? []
  for k in ["AXMainWindow", "AXFocusedWindow"] {
    if let w = r[k], CFGetTypeID(w) == AXUIElementGetTypeID(), !all.contains(where: { CFEqual($0, w) }) { all.append(w as! AXUIElement) }
  }
  let ranked = all.map { w -> (AXUIElement, Int, CGFloat, Int) in
    let f = frame(w) ?? .zero
    let r = attrs(w, ["AXSubrole", "AXChildren"])
    return (w, text(r["AXSubrole"]) == "AXStandardWindow" ? 1 : 0, f.width * f.height, children(r).count)
  }
  if let best = ranked.max(by: { ($0.1, $0.2, $0.3) < ($1.1, $1.2, $1.3) }) { return best.0 }
  throw Fail(message: "\(a.localizedName ?? "app") has no window")
}

let NAMES = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXEnabled",
             "AXSelected", "AXFocused", "AXIdentifier", "AXChildren"]

func children(_ r: [String: AnyObject]) -> [AXUIElement] { (r["AXChildren"] as? [AXUIElement]) ?? [] }
func labelOf(_ r: [String: AnyObject]) -> String? { text(r["AXTitle"]) ?? text(r["AXDescription"]) ?? text(r["AXPlaceholderValue"]) }

// A read stops after `limit` elements or `seconds`, whichever comes first: a big app (Activity Monitor has ~3000
// elements, and some apps answer slowly) would otherwise take minutes. An element whose children were not all
// read is marked truncated, and so is the answer.
var budget = 0
var deadline = Date.distantFuture
var truncated = false

func node(_ e: AXUIElement, _ ref: String, _ depth: Int) -> [String: Any] {
  budget -= 1
  let r = attrs(e, NAMES)
  var n: [String: Any] = ["ref": ref, "role": (text(r["AXRole"]) ?? "?").replacingOccurrences(of: "AX", with: "")]
  if let s = text(r["AXSubrole"]) { n["subrole"] = s.replacingOccurrences(of: "AX", with: "") }
  if let i = text(r["AXIdentifier"]) { n["id"] = i }
  if let l = labelOf(r) { n["label"] = l }
  if let v = text(r["AXValue"]) { n["value"] = v }
  if (r["AXEnabled"] as? Bool) == false { n["disabled"] = true }
  if (r["AXSelected"] as? Bool) == true { n["selected"] = true }
  if (r["AXFocused"] as? Bool) == true { n["focused"] = true }
  let acts = actionNames(e)
  if !acts.isEmpty { n["actions"] = acts }
  let kids = children(r)
  if depth > 0, !kids.isEmpty {
    var read: [[String: Any]] = []
    for (i, k) in kids.enumerated() {
      if budget <= 0 || Date() > deadline { truncated = true; n["truncated"] = true; break }
      read.append(node(k, ref.isEmpty ? "\(i)" : "\(ref).\(i)", depth - 1))
    }
    n["children"] = read
  }
  return n
}

func byRef(_ w: AXUIElement, _ ref: String) throws -> AXUIElement {
  var e = w
  for part in ref.split(separator: ".") where !ref.isEmpty {
    let kids = children(attrs(e, ["AXChildren"]))
    guard let i = Int(part), i < kids.count else { throw Fail(message: "no element \(ref) (the window changed: read it again)") }
    e = kids[i]
  }
  return e
}

/// The first element (depth first) whose identifier, label and role match the ones given.
func find(_ e: AXUIElement, id: String?, label: String?, role: String?) -> AXUIElement? {
  budget -= 1
  if budget < 0 || Date() > deadline { truncated = true; return nil }
  let r = attrs(e, NAMES)
  if (id == nil || text(r["AXIdentifier"]) == id), (label == nil || labelOf(r) == label),
     (role == nil || text(r["AXRole"])?.replacingOccurrences(of: "AX", with: "") == role) { return e }
  for k in children(r) { if let f = find(k, id: id, label: label, role: role) { return f } }
  return nil
}

/// The element a request names: "ref", or "id" and/or "label" (+ "role").
func target(_ w: AXUIElement) throws -> AXUIElement {
  if let ref = req["ref"] as? String { return try byRef(w, ref) }
  let id = req["id"] as? String, label = req["label"] as? String
  guard id != nil || label != nil else { throw Fail(message: "name an element: id, label or ref") }
  let what = [id.map { "id \($0)" }, label.map { "label \($0)" }].compactMap { $0 }.joined(separator: " and ")
  guard let f = find(w, id: id, label: label, role: req["role"] as? String) else {
    throw Fail(message: truncated ? "no element with \(what) among the first \(req["limit"] as? Int ?? 800) searched; act on a ref from read" : "no element with \(what)")
  }
  return f
}

func focus(_ e: AXUIElement) throws {
  let err = AXUIElementSetAttributeValue(e, "AXFocused" as CFString, kCFBooleanTrue)
  if err != .success { throw Fail(message: "focus failed (AXError \(err.rawValue))") }
}

// Virtual key codes (US layout) for `key`: names, letters and digits. "cmd+a", "shift+return", "escape", or a number.
let KEYS: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]
let MODS: [String: CGEventFlags] = ["cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift,
                                    "alt": .maskAlternate, "option": .maskAlternate, "ctrl": .maskControl, "control": .maskControl]

/// Key events go to the app's process only: the app stays where it is, and nothing else receives them.
func post(_ pid: pid_t, _ code: CGKeyCode, _ flags: CGEventFlags, _ chars: String? = nil) {
  let src = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
    if let chars { let u = Array(chars.utf16); e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u) }
    e.flags = flags
    e.postToPid(pid)
    usleep(15_000)
  }
}

func frontmost() -> String { NSWorkspace.shared.frontmostApplication?.localizedName ?? "" }

/// Is `hit` the element `e`, or inside it?
func within(_ hit: AXUIElement, _ e: AXUIElement) -> Bool {
  var cur: AXUIElement? = hit
  for _ in 0..<40 {
    guard let c = cur else { return false }
    if CFEqual(c, e) { return true }
    guard let p = attrs(c, ["AXParent"])["AXParent"], CFGetTypeID(p) == AXUIElementGetTypeID() else { return false }
    cur = (p as! AXUIElement)
  }
  return false
}

/// Show the app's main window again, the way a click on its Dock icon does: opening the running app sends it a
/// reopen event. For an app whose main window was closed, or replaced by another window (WeChat's built-in browser).
/// It brings the app to the front; it waits (up to "seconds", default 3) until the main window has elements, and with
/// "restore" activates the app that was in front before again.
func reopen(_ a: NSRunningApplication) throws -> [String: Any] {
  guard let url = a.bundleURL else { throw Fail(message: "\(a.localizedName ?? "app") has no bundle to reopen") }
  let before = NSWorkspace.shared.frontmostApplication
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = true
  var finished = false
  var failure: String?
  NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, e in
    failure = e?.localizedDescription
    finished = true
  }
  let opened = Date().addingTimeInterval(10)
  while !finished && Date() < opened { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  if !finished { failure = "it did not answer within 10 s" }
  var elements = 0
  let until = Date().addingTimeInterval(req["seconds"] as? Double ?? 3)
  while failure == nil {
    if let w = try? window(a) { elements = children(attrs(w, ["AXChildren"])).count }
    if elements > 0 || Date() > until { break }
    usleep(100_000)
  }
  let was = before?.localizedName ?? ""
  if req["restore"] as? Bool == true, let before, before != a {
    before.activate()
    for _ in 0..<20 where !before.isActive { usleep(50_000) }
  }
  if let failure { throw Fail(message: "could not reopen \(a.localizedName ?? "the app"): \(failure)") }
  return ["ok": true, "window": elements > 0, "frontmost": ["before": was, "after": frontmost()]]
}

// ---------------------------------------------------------------- launch, quit

/// Where an app that is not running lives: the "path" given (ax.ts finds it, Spotlight included), else by bundle id.
func bundleURL(_ name: String) -> URL? {
  if let p = req["path"] as? String { return URL(fileURLWithPath: p) }
  return NSWorkspace.shared.urlForApplication(withBundleIdentifier: name)
}

func running(_ name: String) -> NSRunningApplication? { try? app(name) }

/// Start the app if it is not running, without bringing it to the front (the app in front stays there; "activate":
/// true brings it), and wait (up to "seconds", default 10) until its window has elements. "launched" says whether this call started it: only then
/// is it pagent's to quit.
func launch(_ name: String) throws -> [String: Any] {
  if let a = running(name) { return ["ok": true, "launched": false, "pid": Int(a.processIdentifier)] }
  guard let url = bundleURL(name) else { throw Fail(message: "no app called \(name) on this Mac") }
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = req["activate"] as? Bool == true
  cfg.addsToRecentItems = false
  var started: NSRunningApplication?
  var failure: String?
  var finished = false
  NSWorkspace.shared.openApplication(at: url, configuration: cfg) { a, e in
    started = a
    failure = e?.localizedDescription
    finished = true
  }
  let until = Date().addingTimeInterval(req["seconds"] as? Double ?? 10)
  while !finished && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  guard let a = started else { throw Fail(message: "could not launch \(name): \(failure ?? "it did not start in time")") }
  var ready = false
  while Date() < until {
    if let w = try? window(a), !children(attrs(w, ["AXChildren"])).isEmpty { ready = true; break }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  }
  return ["ok": true, "launched": true, "pid": Int(a.processIdentifier), "window": ready]
}

/// Quit the app, but only the process given (the one pagent launched): if the person quit it and opened it again, it
/// is theirs now (another pid), and stays.
func quit(_ name: String) throws -> [String: Any] {
  guard let pid = req["pid"] as? Int else { throw Fail(message: "quit needs the pid of the process pagent launched") }
  guard let a = NSRunningApplication(processIdentifier: pid_t(pid)), !a.isTerminated else { return ["ok": true, "quit": false, "why": "not running"] }
  guard a.localizedName == name || a.bundleIdentifier == name else { return ["ok": true, "quit": false, "why": "that process is another app"] }
  _ = a.terminate()
  let until = Date().addingTimeInterval(req["seconds"] as? Double ?? 5)
  while !a.isTerminated && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  // An app that asks first (unsaved changes) stays open, and says so.
  return a.isTerminated ? ["ok": true, "quit": true] : ["ok": true, "quit": false, "why": "it did not quit within 5 s (it may be asking something)"]
}

// ---------------------------------------------------------------- watch
// Long-lived: a JSON line on stdout per AX notification of the app, until it is killed (or its parent is gone). The
// app need not be running: it waits for it to start, and again after it quits.
//   {"type":"waiting"}                                  not running
//   {"type":"attached","pid":123}
//   {"type":"change","notification":"AXValueChanged","role":"StaticText"}   (no labels or values: they can be private)
//   {"type":"detached"}                                 it quit (then waiting again)
//   {"type":"error","error":"…"}                        it runs but cannot be observed (tried again on its next start)
// With a target (id / label, role), only changes inside it are reported, and the window-level ones.

let WATCHED = ["AXValueChanged", "AXUIElementDestroyed", "AXCreated", "AXTitleChanged", "AXFocusedWindowChanged",
               "AXMainWindowChanged", "AXWindowCreated", "AXFocusedUIElementChanged", "AXSelectedChildrenChanged",
               "AXSelectedRowsChanged", "AXRowCountChanged", "AXLayoutChanged"]
let WINDOW_LEVEL: Set<String> = ["AXFocusedWindowChanged", "AXMainWindowChanged", "AXWindowCreated"]

func line(_ v: [String: Any]) {
  var data = try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

var observer: AXObserver?
var watched: NSRunningApplication?
var targetElement: AXUIElement?

func roleOf(_ e: AXUIElement) -> String? { text(attrs(e, ["AXRole"])["AXRole"])?.replacingOccurrences(of: "AX", with: "") }

/// Whether a notification is about the watched part of the window: inside the target (found again when the one found
/// before is gone), or about the windows themselves.
func concerns(_ e: AXUIElement, _ name: String) -> Bool {
  if req["id"] == nil && req["label"] == nil { return true }
  if WINDOW_LEVEL.contains(name) { return true }
  guard let a = watched else { return false }
  if targetElement == nil || roleOf(targetElement!) == nil {
    budget = 5000
    deadline = Date().addingTimeInterval(2)
    targetElement = (try? window(a)).flatMap { find($0, id: req["id"] as? String, label: req["label"] as? String, role: req["role"] as? String) }
  }
  guard let t = targetElement else { return false }
  return within(e, t)
}

/// The observer's callback is a C function and can capture nothing: it reaches this through its refcon.
final class Sink {
  let handle: (AXUIElement, String) -> Void
  init(_ handle: @escaping (AXUIElement, String) -> Void) { self.handle = handle }
}
let sink = Sink { element, name in
  guard concerns(element, name) else { return }
  var v: [String: Any] = ["type": "change", "notification": name]
  if let r = roleOf(element) { v["role"] = r }
  line(v)
}

func attach(_ a: NSRunningApplication) {
  var o: AXObserver?
  let err = AXObserverCreate(a.processIdentifier, { _, element, notification, refcon in
    Unmanaged<Sink>.fromOpaque(refcon!).takeUnretainedValue().handle(element, notification as String)
  }, &o)
  guard err == .success, let o else { line(["type": "error", "error": "could not observe \(a.localizedName ?? "the app") (AXError \(err.rawValue))"]); return }
  let root = AXUIElementCreateApplication(a.processIdentifier)
  var added = 0
  var last = AXError.success
  for n in (req["notifications"] as? [String]) ?? WATCHED {
    let r = AXObserverAddNotification(o, root, n as CFString, Unmanaged.passUnretained(sink).toOpaque())
    if r == .success || r == .notificationAlreadyRegistered { added += 1 } else { last = r }
  }
  guard added > 0 else {
    line(["type": "error", "error": "\(a.localizedName ?? "the app") takes no observers (AXError \(last.rawValue))"])
    return
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
  observer = o
  watched = a
  targetElement = nil
  line(["type": "attached", "pid": Int(a.processIdentifier)])
}

func detach() {
  if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode) }
  observer = nil
  watched = nil
  targetElement = nil
}

func watch(_ name: String) -> Never {
  let center = NSWorkspace.shared.notificationCenter
  let matches = { (a: NSRunningApplication?) in a?.localizedName == name || a?.bundleIdentifier == name }
  center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { n in
    guard watched == nil, matches(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication), let a = running(name) else { return }
    attach(a)
  }
  center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { n in
    let a = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    guard let w = watched, a?.processIdentifier == w.processIdentifier else { return }
    detach()
    line(["type": "detached"])
    if let other = running(name) { attach(other) } else { line(["type": "waiting"]) }
  }
  if let a = running(name) { attach(a) } else { line(["type": "waiting"]) }
  // Gone with its parent: reparented to launchd means the server died without killing it.
  Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in if getppid() == 1 { exit(0) } }
  RunLoop.main.run()
  exit(0)
}

do {
  guard AXIsProcessTrusted() else { throw Fail(message: "pagent needs Accessibility access: System Settings → Privacy & Security → Accessibility") }
  let name = req["app"] as? String ?? ""
  // These need no running app (or wait for one).
  switch req["op"] as? String {
  case "launch": out(try launch(name)); exit(0)
  case "quit": out(try quit(name)); exit(0)
  case "watch":
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1)
    watch(name)
  default: break
  }
  let a = try app(name)
  // An element that does not answer within a second is skipped rather than waited on (the default is 6s each).
  AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1)
  // Before the window lookup below: the app may have no main window at all.
  if req["op"] as? String == "reopen" {
    out(try reopen(a))
    exit(0)
  }
  budget = req["limit"] as? Int ?? 800
  deadline = Date().addingTimeInterval(req["seconds"] as? Double ?? 5)
  let w = try window(a)
  switch req["op"] as? String {
  case "read":
    let tree = node(w, "", req["depth"] as? Int ?? 40)
    out(["ok": true, "app": a.localizedName ?? "", "window": tree, "truncated": truncated])
  case "act":
    let t = try target(w)
    let action = req["action"] as? String ?? "press"
    let err: AXError
    if action == "set" {
      err = AXUIElementSetAttributeValue(t, "AXValue" as CFString, (req["value"] as? String ?? "") as CFString)
    } else if action == "focus" {
      err = AXUIElementSetAttributeValue(t, "AXFocused" as CFString, kCFBooleanTrue)
    } else {
      err = AXUIElementPerformAction(t, ("AX" + action.prefix(1).uppercased() + action.dropFirst()) as CFString)
    }
    // Success means the app accepted the request, not that it did anything: some apps (WeChat) accept a press and
    // ignore it. Read back what should have changed.
    if err != .success { throw Fail(message: "\(action) failed (AXError \(err.rawValue))") }
    out(["ok": true])
  case "key":
    // With a target: focus it and check that it took, before any key is sent.
    if req["id"] != nil || req["label"] != nil || req["ref"] != nil {
      let t = try target(w)
      try focus(t)
      guard (attrs(t, ["AXFocused"])["AXFocused"] as? Bool) == true else { throw Fail(message: "the element did not take the focus; no key sent") }
    }
    if let s = req["text"] as? String {
      for ch in s { post(a.processIdentifier, 0, [], String(ch)) }
    } else {
      let parts = ((req["key"] as? String) ?? "").lowercased().split(separator: "+").map(String.init)
      guard let last = parts.last, let code = KEYS[last] ?? CGKeyCode(last) else { throw Fail(message: "unknown key \(req["key"] ?? "")") }
      var flags: CGEventFlags = []
      for m in parts.dropLast() {
        guard let f = MODS[m] else { throw Fail(message: "unknown modifier \(m) (cmd, shift, alt, ctrl)") }
        flags.insert(f)
      }
      post(a.processIdentifier, code, flags)
    }
    out(["ok": true])
  case "click":
    // A real left click at the element's centre, for what an app only does for a real click (WeChat opens a chat
    // only so). It needs the app in front, so it activates it; before clicking it checks that the element at that
    // point on screen is the target (or inside it), so nothing else is ever clicked. The cursor is put back, and
    // with "restore" the app that was in front before is activated again.
    let t = try target(w)
    guard let f = frame(t), f.width > 0, f.height > 0 else { throw Fail(message: "the element is not on screen (no size); scroll it into view") }
    let before = NSWorkspace.shared.frontmostApplication
    if !a.isActive {
      a.activate()
      for _ in 0..<30 where !a.isActive { usleep(50_000) }
    }
    usleep(150_000)
    let p = CGPoint(x: f.midX, y: f.midY)
    var hit: AXUIElement?
    AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit)
    guard let hit, within(hit, t) else {
      if req["restore"] as? Bool == true, let before, before != a { before.activate() }
      throw Fail(message: "not clicked: the element at its position on screen is something else (covered, or scrolled out of view)")
    }
    let saved = CGEvent(source: nil)?.location
    let src = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
      let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
      e.setIntegerValueField(.mouseEventClickState, value: 1)
      e.post(tap: .cghidEventTap)
      usleep(50_000)
    }
    usleep(300_000)
    if let saved { CGWarpMouseCursorPosition(saved); CGAssociateMouseAndMouseCursorPosition(1) }
    let was = before?.localizedName ?? ""
    if req["restore"] as? Bool == true, let before, before != a {
      before.activate()
      for _ in 0..<20 where !before.isActive { usleep(50_000) }
    }
    out(["ok": true, "frontmost": ["before": was, "after": frontmost()]])
  case "window":
    // The CGWindowID (for screencapture -l): the window list matched by pid, then frame and title (names are hidden
    // without Screen Recording access, and an app can have several windows of the same size, some off screen).
    let title = text(attrs(w, ["AXTitle"])["AXTitle"])
    let f = frame(w)
    let list = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == a.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }
    func bounds(_ x: [String: Any]) -> CGRect? { (x[kCGWindowBounds as String] as! CFDictionary?).flatMap { CGRect(dictionaryRepresentation: $0) } }
    let framed = mine.filter { f != nil && bounds($0) == f }.sorted { (($0[kCGWindowIsOnscreen as String] as? Bool) ?? false) && !(($1[kCGWindowIsOnscreen as String] as? Bool) ?? false) }
    let match = framed.first { ($0[kCGWindowName as String] as? String) == title } ?? framed.first ?? mine.first { ($0[kCGWindowName as String] as? String) == title } ?? mine.first
    guard let id = match?[kCGWindowNumber as String] as? Int else { throw Fail(message: "window not found") }
    // Without Screen Recording access, screencapture still succeeds but the picture has no window content.
    out(["ok": true, "id": id, "screenRecording": CGPreflightScreenCaptureAccess()])
  default:
    throw Fail(message: "unknown op")
  }
} catch let f as Fail {
  out(["ok": false, "error": f.message])
} catch {
  out(["ok": false, "error": "\(error)"])
}
