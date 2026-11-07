#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

static void emit(NSDictionary *message) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:&error];
    if (!data) return;
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void emitOk(NSString *identifier, id result) {
    emit(@{ @"id": identifier ?: @"", @"ok": @YES, @"result": result ?: [NSNull null] });
}

static void emitError(NSString *identifier, NSString *code, NSString *message) {
    emit(@{ @"id": identifier ?: @"", @"ok": @NO,
            @"error": @{ @"code": code ?: @"HelperError", @"message": message ?: @"Unknown failure." } });
}

static BOOL hasAccessibility(void) {
    return AXIsProcessTrusted();
}

static NSTimeInterval lastSyntheticEvent = 0;

static void markSyntheticEvent(void) {
    lastSyntheticEvent = [NSDate timeIntervalSinceReferenceDate];
}

static NSDictionary *inputLastActivity(void) {
    CGEventType anyInput = kCGAnyInputEventType;
    double idleSeconds = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, anyInput);
    double millisecondsAgo = idleSeconds * 1000.0;

    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    double sinceOursMs = lastSyntheticEvent > 0 ? (now - lastSyntheticEvent) * 1000.0 : 1e9;
    BOOL ours = fabs(sinceOursMs - millisecondsAgo) < 250.0;

    return @{ @"lastInputTick": @((long long)((now - idleSeconds) * 1000.0)),
              @"millisecondsAgo": @((long long)millisecondsAgo),
              @"source": ours ? @"automation" : @"physical" };
}

static CGEventFlags flagsForModifiers(NSArray *modifiers) {
    CGEventFlags flags = 0;
    for (NSString *modifier in modifiers) {
        NSString *name = [modifier lowercaseString];
        if ([name isEqualToString:@"cmd"] || [name isEqualToString:@"command"] || [name isEqualToString:@"meta"]) flags |= kCGEventFlagMaskCommand;
        else if ([name isEqualToString:@"ctrl"] || [name isEqualToString:@"control"]) flags |= kCGEventFlagMaskControl;
        else if ([name isEqualToString:@"alt"] || [name isEqualToString:@"option"]) flags |= kCGEventFlagMaskAlternate;
        else if ([name isEqualToString:@"shift"]) flags |= kCGEventFlagMaskShift;
    }
    return flags;
}

static NSDictionary *inputClick(NSDictionary *params) {
    double x = [params[@"x"] doubleValue];
    double y = [params[@"y"] doubleValue];
    BOOL right = [[params[@"button"] ?: @"left" lowercaseString] isEqualToString:@"right"];
    BOOL doubleClick = [params[@"double"] boolValue];
    CGPoint point = CGPointMake(x, y);

    CGEventType downType = right ? kCGEventRightMouseDown : kCGEventLeftMouseDown;
    CGEventType upType = right ? kCGEventRightMouseUp : kCGEventLeftMouseUp;
    CGMouseButton button = right ? kCGMouseButtonRight : kCGMouseButtonLeft;

    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, button);
    CGEventPost(kCGHIDEventTap, move);
    CFRelease(move);

    for (int click = 1; click <= (doubleClick ? 2 : 1); click++) {
        CGEventRef down = CGEventCreateMouseEvent(NULL, downType, point, button);
        CGEventSetIntegerValueField(down, kCGMouseEventClickState, click);
        CGEventPost(kCGHIDEventTap, down);
        CFRelease(down);

        CGEventRef up = CGEventCreateMouseEvent(NULL, upType, point, button);
        CGEventSetIntegerValueField(up, kCGMouseEventClickState, click);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(up);
    }
    usleep(40000);
    CGEventRef probe = CGEventCreate(NULL);
    CGPoint landed = CGEventGetLocation(probe);
    CFRelease(probe);
    markSyntheticEvent();
    return @{ @"clicked": @YES, @"x": @(x), @"y": @(y),
              @"button": right ? @"right" : @"left", @"double": @(doubleClick),
              @"cursorX": @(landed.x), @"cursorY": @(landed.y) };
}

static NSDictionary *inputSendText(NSDictionary *params) {
    NSString *text = params[@"text"] ?: @"";
    for (NSUInteger index = 0; index < text.length; index += 20) {
        NSRange range = NSMakeRange(index, MIN((NSUInteger)20, text.length - index));
        NSString *chunk = [text substringWithRange:range];
        unichar buffer[20];
        [chunk getCharacters:buffer range:NSMakeRange(0, chunk.length)];

        CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
        CGEventKeyboardSetUnicodeString(down, chunk.length, buffer);
        CGEventPost(kCGHIDEventTap, down);
        CFRelease(down);

        CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
        CGEventKeyboardSetUnicodeString(up, chunk.length, buffer);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(up);
        usleep(1500);
    }
    markSyntheticEvent();
    return @{ @"typed": @(text.length) };
}

static NSDictionary *inputSendKey(NSDictionary *params, NSString **failure) {
    NSString *combination = params[@"key"] ?: @"";
    if (!combination.length) { *failure = @"A key is required."; return nil; }

    NSArray *parts = [combination componentsSeparatedByCharactersInSet:
                      [NSCharacterSet characterSetWithCharactersInString:@"+_"]];
    NSString *keyName = [[parts.lastObject stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet] uppercaseString];
    NSMutableArray *modifiers = [NSMutableArray array];
    for (NSUInteger index = 0; index + 1 < parts.count; index++) {
        NSString *modifier = [[parts[index] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet] lowercaseString];
        if ([modifier isEqualToString:@"ctrl"] || [modifier isEqualToString:@"control"]) modifier = @"cmd";
        [modifiers addObject:modifier];
    }

    static NSDictionary *keyCodes = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        keyCodes = @{
            @"ENTER": @36, @"RETURN": @36, @"TAB": @48, @"SPACE": @49, @"DELETE": @51,
            @"BACKSPACE": @51, @"ESCAPE": @53, @"ESC": @53, @"LEFT": @123, @"RIGHT": @124,
            @"DOWN": @125, @"UP": @126, @"HOME": @115, @"END": @119, @"PAGEUP": @116,
            @"PAGEDOWN": @121, @"F1": @122, @"F2": @120, @"F3": @99, @"F4": @118, @"F5": @96,
            @"F6": @97, @"F7": @98, @"F8": @100, @"F9": @101, @"F10": @109, @"F11": @103, @"F12": @111,
            @"A": @0, @"B": @11, @"C": @8, @"D": @2, @"E": @14, @"F": @3, @"G": @5, @"H": @4,
            @"I": @34, @"J": @38, @"K": @40, @"L": @37, @"M": @46, @"N": @45, @"O": @31, @"P": @35,
            @"Q": @12, @"R": @15, @"S": @1, @"T": @17, @"U": @32, @"V": @9, @"W": @13, @"X": @7,
            @"Y": @16, @"Z": @6
        };
    });
    NSNumber *code = keyCodes[keyName];
    if (!code) { *failure = [NSString stringWithFormat:@"%@ is not a key this helper can press.", combination]; return nil; }

    CGEventFlags flags = flagsForModifiers(modifiers);
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code.intValue, true);
    CGEventSetFlags(down, flags);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);

    CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code.intValue, false);
    CGEventSetFlags(up, flags);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);
    usleep(30000);
    markSyntheticEvent();
    return @{ @"pressed": combination, @"keyCode": code, @"modifiers": modifiers };
}

static NSDictionary *inputScroll(NSDictionary *params) {
    int delta = [params[@"delta"] intValue];
    int notches = delta;
    if (abs(delta) >= 120) notches = delta / 120;
    if (notches == 0) notches = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
    CGEventRef scroll = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, -notches * 3);
    CGEventPost(kCGHIDEventTap, scroll);
    CFRelease(scroll);
    markSyntheticEvent();
    return @{ @"scrolled": @(delta), @"notches": @(notches) };
}

static NSArray *windowsList(NSDictionary *params) {
    BOOL visibleOnly = params[@"visibleOnly"] ? [params[@"visibleOnly"] boolValue] : YES;
    CGWindowListOption options = visibleOnly
        ? (kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements)
        : kCGWindowListExcludeDesktopElements;
    CFArrayRef raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID);
    NSMutableArray *windows = [NSMutableArray array];
    for (NSDictionary *entry in (__bridge NSArray *)raw) {
        NSString *title = entry[(id)kCGWindowName] ?: @"";
        NSString *owner = entry[(id)kCGWindowOwnerName] ?: @"";
        NSNumber *layer = entry[(id)kCGWindowLayer];
        if (layer && layer.intValue != 0) continue;
        if (title.length == 0 && owner.length == 0) continue;
        NSDictionary *bounds = entry[(id)kCGWindowBounds];
        CGRect rect = CGRectZero;
        if (bounds) CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect);
        [windows addObject:@{
            @"handle": [entry[(id)kCGWindowNumber] stringValue] ?: @"",
            @"title": title.length ? title : owner,
            @"processName": owner,
            @"processId": entry[(id)kCGWindowOwnerPID] ?: @0,
            @"bounds": @{ @"x": @(rect.origin.x), @"y": @(rect.origin.y),
                          @"width": @(rect.size.width), @"height": @(rect.size.height) }
        }];
    }
    if (raw) CFRelease(raw);
    return windows;
}

static NSDictionary *screenCapture(NSDictionary *params, NSString **failure) {
    NSString *destination = params[@"path"];
    if (!destination.length) { *failure = @"A destination path is required."; return nil; }

    __block CGImageRef captured = NULL;
    __block NSString *problem = nil;

    dispatch_semaphore_t contentReady = dispatch_semaphore_create(0);
    __block SCShareableContent *shareable = nil;
    [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
        shareable = content;
        if (error) problem = error.localizedDescription;
        dispatch_semaphore_signal(contentReady);
    }];
    if (dispatch_semaphore_wait(contentReady, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
        *failure = @"The screen could not be captured. Grant Screen Recording in System Settings > Privacy & Security, then try again.";
        return nil;
    }
    if (!shareable || shareable.displays.count == 0) {
        *failure = problem ?: @"No display was available to capture.";
        return nil;
    }

    SCDisplay *display = shareable.displays.firstObject;
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
    SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display.displayID);
    size_t pixelWidth = mode ? CGDisplayModeGetPixelWidth(mode) : (size_t)display.width;
    size_t pixelHeight = mode ? CGDisplayModeGetPixelHeight(mode) : (size_t)display.height;
    if (mode) CGDisplayModeRelease(mode);
    configuration.width = pixelWidth;
    configuration.height = pixelHeight;
    configuration.capturesAudio = NO;

    dispatch_semaphore_t shotReady = dispatch_semaphore_create(0);
    [SCScreenshotManager captureImageWithFilter:filter
                                  configuration:configuration
                              completionHandler:^(CGImageRef image, NSError *error) {
        if (image) captured = CGImageRetain(image);
        if (error) problem = error.localizedDescription;
        dispatch_semaphore_signal(shotReady);
    }];
    if (dispatch_semaphore_wait(shotReady, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
        *failure = @"The screen capture timed out.";
        return nil;
    }
    if (!captured) {
        *failure = problem ?: @"The screen could not be captured. Grant Screen Recording in System Settings > Privacy & Security.";
        return nil;
    }

    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:captured];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    size_t width = CGImageGetWidth(captured);
    size_t height = CGImageGetHeight(captured);
    CGImageRelease(captured);

    NSError *writeError = nil;
    if (![png writeToFile:destination options:NSDataWritingAtomic error:&writeError]) {
        *failure = writeError.localizedDescription ?: @"The screenshot could not be written.";
        return nil;
    }
    return @{ @"path": destination, @"bytes": @(png.length), @"width": @(width), @"height": @(height) };
}

static NSString *axString(AXUIElementRef element, CFStringRef attribute) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) return @"";
    NSString *result = @"";
    if (CFGetTypeID(value) == CFStringGetTypeID()) result = [NSString stringWithString:(__bridge NSString *)value];
    else if (CFGetTypeID(value) == CFNumberGetTypeID()) result = [(__bridge NSNumber *)value stringValue];
    else if (CFGetTypeID(value) == CFBooleanGetTypeID()) result = CFBooleanGetValue(value) ? @"true" : @"false";
    CFRelease(value);
    return result;
}

static BOOL axBool(AXUIElementRef element, CFStringRef attribute) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) return NO;
    BOOL result = (CFGetTypeID(value) == CFBooleanGetTypeID()) && CFBooleanGetValue(value);
    CFRelease(value);
    return result;
}

static CGRect axFrame(AXUIElementRef element) {
    CGPoint origin = CGPointZero;
    CGSize size = CGSizeZero;
    CFTypeRef positionValue = NULL, sizeValue = NULL;
    if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &positionValue) == kAXErrorSuccess && positionValue) {
        AXValueGetValue((AXValueRef)positionValue, kAXValueCGPointType, &origin);
        CFRelease(positionValue);
    }
    if (AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeValue) == kAXErrorSuccess && sizeValue) {
        AXValueGetValue((AXValueRef)sizeValue, kAXValueCGSizeType, &size);
        CFRelease(sizeValue);
    }
    return CGRectMake(origin.x, origin.y, size.width, size.height);
}

static NSArray<NSString *> *axActions(AXUIElementRef element) {
    CFArrayRef names = NULL;
    if (AXUIElementCopyActionNames(element, &names) != kAXErrorSuccess || !names) return @[];
    NSArray *result = [(__bridge NSArray *)names copy];
    CFRelease(names);
    return result;
}

static NSString *controlTypeForRole(NSString *role, NSString *subrole) {
    if ([subrole isEqualToString:@"AXSecureTextField"]) return @"Edit";
    static NSDictionary *map = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        map = @{
            @"AXButton": @"Button", @"AXRadioButton": @"RadioButton", @"AXCheckBox": @"CheckBox",
            @"AXPopUpButton": @"ComboBox", @"AXComboBox": @"ComboBox", @"AXTextField": @"Edit",
            @"AXTextArea": @"Edit", @"AXStaticText": @"Text", @"AXMenuItem": @"MenuItem",
            @"AXMenuBarItem": @"MenuItem", @"AXMenu": @"Menu", @"AXMenuBar": @"MenuBar",
            @"AXWindow": @"Window", @"AXList": @"List", @"AXRow": @"ListItem", @"AXCell": @"DataItem",
            @"AXTable": @"Table", @"AXOutline": @"Tree", @"AXTabGroup": @"Tab", @"AXLink": @"Hyperlink",
            @"AXImage": @"Image", @"AXSlider": @"Slider", @"AXScrollBar": @"ScrollBar",
            @"AXGroup": @"Group", @"AXToolbar": @"ToolBar", @"AXProgressIndicator": @"ProgressBar",
            @"AXSplitGroup": @"Pane", @"AXScrollArea": @"Pane", @"AXWebArea": @"Document"
        };
    });
    NSString *mapped = map[role ?: @""];
    if (mapped) return mapped;
    if ([role hasPrefix:@"AX"]) return [role substringFromIndex:2];
    return role.length ? role : @"Custom";
}

static NSArray<NSString *> *patternsFor(AXUIElementRef element, NSString *role) {
    NSMutableArray *patterns = [NSMutableArray array];
    NSArray *actions = axActions(element);
    if ([actions containsObject:(__bridge NSString *)kAXPressAction]) [patterns addObject:@"Invoke"];
    if ([actions containsObject:(__bridge NSString *)kAXIncrementAction]) [patterns addObject:@"RangeValue"];
    if ([actions containsObject:(__bridge NSString *)kAXShowMenuAction]) [patterns addObject:@"ExpandCollapse"];
    CFTypeRef settable = NULL;
    Boolean valueSettable = false;
    if (AXUIElementIsAttributeSettable(element, kAXValueAttribute, &valueSettable) == kAXErrorSuccess && valueSettable) {
        [patterns addObject:@"Value"];
    }
    if (settable) CFRelease(settable);
    if ([role isEqualToString:@"AXCheckBox"] || [role isEqualToString:@"AXRadioButton"]) [patterns addObject:@"Toggle"];
    if ([role isEqualToString:@"AXRow"] || [role isEqualToString:@"AXCell"]) [patterns addObject:@"SelectionItem"];
    return patterns;
}

static NSDictionary *describeElement(AXUIElementRef element, NSInteger parentIndex, pid_t pid) {
    NSString *role = axString(element, kAXRoleAttribute);
    NSString *subrole = axString(element, kAXSubroleAttribute);
    NSString *title = axString(element, kAXTitleAttribute);
    NSString *description = axString(element, kAXDescriptionAttribute);
    NSString *value = axString(element, kAXValueAttribute);
    NSString *name = title.length ? title : (description.length ? description : value);
    CGRect frame = axFrame(element);
    BOOL secure = [subrole isEqualToString:@"AXSecureTextField"];

    return @{
        @"parentIndex": @(parentIndex),
        @"name": name ?: @"",
        @"automationId": axString(element, CFSTR("AXIdentifier")),
        @"className": role ?: @"",
        @"controlType": controlTypeForRole(role, subrole),
        @"processId": @(pid),
        @"enabled": @(axBool(element, kAXEnabledAttribute)),
        @"offscreen": @(CGRectIsEmpty(frame)),
        @"focusable": @(!CGRectIsEmpty(frame) && axBool(element, kAXEnabledAttribute)),
        @"focused": @(axBool(element, kAXFocusedAttribute)),
        @"password": @(secure),
        @"helpText": axString(element, kAXHelpAttribute),
        @"accessKey": @"",
        @"value": secure ? @"" : (value ?: @""),
        @"selected": @(axBool(element, kAXSelectedAttribute)),
        @"checked": @([value isEqualToString:@"1"]),
        @"expanded": @(axBool(element, kAXExpandedAttribute)),
        @"bounds": @{ @"x": @(frame.origin.x), @"y": @(frame.origin.y),
                      @"width": @(frame.size.width), @"height": @(frame.size.height) },
        @"patterns": patternsFor(element, role)
    };
}

static void walkTree(AXUIElementRef root, pid_t pid, NSMutableArray *out,
                     NSMutableArray *elementRefs, NSInteger maxElements, NSInteger maxDepth) {
    NSMutableArray *queue = [NSMutableArray arrayWithObject:@[(__bridge id)root, @(-1), @0]];
    while (queue.count > 0 && out.count < (NSUInteger)maxElements) {
        NSArray *entry = queue.firstObject;
        [queue removeObjectAtIndex:0];
        AXUIElementRef element = (__bridge AXUIElementRef)entry[0];
        NSInteger parentIndex = [entry[1] integerValue];
        NSInteger depth = [entry[2] integerValue];

        NSInteger myIndex = (NSInteger)out.count;
        [out addObject:describeElement(element, parentIndex, pid)];
        [elementRefs addObject:(__bridge id)element];
        if (depth >= maxDepth) continue;

        CFTypeRef children = NULL;
        if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
            for (id child in (__bridge NSArray *)children) {
                [queue addObject:@[child, @(myIndex), @(depth + 1)]];
            }
            CFRelease(children);
        }
    }
}

static pid_t frontmostPid(void) {
    CFArrayRef raw = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    pid_t owner = 0;
    for (NSDictionary *entry in (__bridge NSArray *)raw) {
        NSNumber *layer = entry[(id)kCGWindowLayer];
        if (layer && layer.intValue != 0) continue;
        owner = (pid_t)[entry[(id)kCGWindowOwnerPID] intValue];
        break;
    }
    if (raw) CFRelease(raw);
    if (owner) return owner;
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    return front ? front.processIdentifier : 0;
}

static AXUIElementRef copyFocusedWindow(pid_t pid) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) return NULL;
    CFTypeRef window = NULL;
    if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window) != kAXErrorSuccess || !window) {
        CFTypeRef windows = NULL;
        if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &windows) == kAXErrorSuccess && windows) {
            NSArray *list = (__bridge NSArray *)windows;
            if (list.count > 0) window = CFRetain((__bridge CFTypeRef)list.firstObject);
            CFRelease(windows);
        }
    }
    CFRelease(app);
    return (AXUIElementRef)window;
}

static NSDictionary *uiaSnapshot(NSDictionary *params, NSMutableArray *elementRefs) {
    NSDictionary *windowSpec = params[@"window"];
    pid_t pid = windowSpec[@"processId"] ? (pid_t)[windowSpec[@"processId"] intValue] : frontmostPid();
    if (pid <= 0) return nil;

    NSInteger maxElements = params[@"maxElements"] ? [params[@"maxElements"] integerValue] : 400;
    NSInteger maxDepth = params[@"maxDepth"] ? [params[@"maxDepth"] integerValue] : 18;
    maxElements = MAX(1, MIN(2000, maxElements));

    AXUIElementRef window = copyFocusedWindow(pid);
    if (!window) return nil;

    NSMutableArray *elements = [NSMutableArray array];
    walkTree(window, pid, elements, elementRefs, maxElements, maxDepth);
    CFRelease(window);
    if (elements.count == 0) return nil;

    return @{ @"root": elements.firstObject, @"elements": elements,
              @"truncated": @(elements.count >= (NSUInteger)maxElements) };
}

static BOOL elementMatches(NSDictionary *element, NSDictionary *selector) {
    NSString *name = selector[@"name"];
    NSString *nameContains = selector[@"nameContains"];
    NSString *automationId = selector[@"automationId"];
    NSString *className = selector[@"className"];
    NSString *controlType = selector[@"controlType"];
    NSString *elementName = element[@"name"] ?: @"";

    if (name.length && [elementName caseInsensitiveCompare:name] != NSOrderedSame) return NO;
    if (nameContains.length && [elementName rangeOfString:nameContains options:NSCaseInsensitiveSearch].location == NSNotFound) return NO;
    if (automationId.length && ![element[@"automationId"] isEqualToString:automationId]) return NO;
    if (className.length && [element[@"className"] caseInsensitiveCompare:className] != NSOrderedSame) return NO;
    if (controlType.length && [element[@"controlType"] caseInsensitiveCompare:controlType] != NSOrderedSame) return NO;
    return YES;
}

static NSDictionary *windowsFocus(NSDictionary *params, NSString **failure) {
    NSString *wantedTitle = params[@"title"] ?: @"";
    pid_t wantedPid = params[@"processId"] ? (pid_t)[params[@"processId"] intValue] : 0;

    for (NSDictionary *window in windowsList(@{ @"visibleOnly": @YES })) {
        BOOL titleMatches = wantedTitle.length
            && [window[@"title"] rangeOfString:wantedTitle options:NSCaseInsensitiveSearch].location != NSNotFound;
        BOOL pidMatches = wantedPid && [window[@"processId"] intValue] == wantedPid;
        if (!titleMatches && !pidMatches) continue;

        pid_t pid = (pid_t)[window[@"processId"] intValue];
        NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        if (!application) continue;

        [application activateWithOptions:NSApplicationActivateAllWindows];
        AXError frontmostResult = kAXErrorSuccess;
        AXUIElementRef applicationElement = AXUIElementCreateApplication(pid);
        if (applicationElement) {
            frontmostResult = AXUIElementSetAttributeValue(applicationElement, kAXFrontmostAttribute, kCFBooleanTrue);
            CFRelease(applicationElement);
        }
        AXUIElementRef target = copyFocusedWindow(pid);
        if (target) { AXUIElementPerformAction(target, kAXRaiseAction); CFRelease(target); }

        pid_t frontmost = 0;
        for (int attempt = 0; attempt < 12; attempt++) {
            usleep(150000);
            frontmost = frontmostPid();
            if (frontmost == pid) break;
        }
        if (frontmost && frontmost != pid) {
            NSRunningApplication *blocker = [NSRunningApplication runningApplicationWithProcessIdentifier:frontmost];
            *failure = hasAccessibility()
                ? [NSString stringWithFormat:
                    @"macOS kept %@ in front and did not raise the requested window (AXFrontmost=%d).",
                    blocker.localizedName ?: @"another application", (int)frontmostResult]
                : @"OmniAgent needs Accessibility permission to bring a window to the front. Open System Settings > Privacy & Security > Accessibility and switch OmniAgent on.";
            return nil;
        }
        return @{ @"focused": window[@"title"] ?: @"", @"processId": @(pid) };
    }
    *failure = [NSString stringWithFormat:@"No window matching \"%@\" is open.", wantedTitle];
    return nil;
}

static NSArray *findMatches(NSDictionary *params, NSMutableArray *refsOut, NSMutableArray *descriptionsOut) {
    NSMutableArray *refs = [NSMutableArray array];
    NSDictionary *snapshot = uiaSnapshot(params, refs);
    if (!snapshot) return nil;
    NSArray *elements = snapshot[@"elements"];
    NSDictionary *selector = params[@"selector"] ?: @{};

    NSMutableArray *matchedIndexes = [NSMutableArray array];
    for (NSUInteger index = 0; index < elements.count; index++) {
        if (elementMatches(elements[index], selector)) [matchedIndexes addObject:@(index)];
    }
    if (params[@"index"]) {
        NSInteger wanted = [params[@"index"] integerValue];
        if (wanted >= 0 && wanted < (NSInteger)matchedIndexes.count) matchedIndexes = [@[matchedIndexes[wanted]] mutableCopy];
        else matchedIndexes = [NSMutableArray array];
    }
    for (NSNumber *index in matchedIndexes) {
        [refsOut addObject:refs[index.unsignedIntegerValue]];
        [descriptionsOut addObject:elements[index.unsignedIntegerValue]];
    }
    return matchedIndexes;
}

static NSDictionary *uiaInvoke(NSDictionary *params, NSString **failure) {
    NSMutableArray *refs = [NSMutableArray array];
    NSMutableArray *descriptions = [NSMutableArray array];
    if (!findMatches(params, refs, descriptions)) { *failure = @"No window was readable."; return nil; }
    if (refs.count == 0) { *failure = @"No control matched that selector."; return nil; }

    AXUIElementRef element = (__bridge AXUIElementRef)refs.firstObject;
    AXError pressed = AXUIElementPerformAction(element, kAXPressAction);
    if (pressed != kAXErrorSuccess) {
        NSDictionary *bounds = descriptions.firstObject[@"bounds"];
        double width = [bounds[@"width"] doubleValue], height = [bounds[@"height"] doubleValue];
        if (width <= 0 || height <= 0) { *failure = @"That control cannot be activated and has no on-screen position."; return nil; }
        inputClick(@{ @"x": @([bounds[@"x"] doubleValue] + width / 2),
                      @"y": @([bounds[@"y"] doubleValue] + height / 2) });
        return @{ @"invoked": descriptions.firstObject[@"name"] ?: @"", @"method": @"click" };
    }
    return @{ @"invoked": descriptions.firstObject[@"name"] ?: @"", @"method": @"press" };
}

static NSDictionary *uiaSetValue(NSDictionary *params, NSString **failure) {
    NSMutableArray *refs = [NSMutableArray array];
    NSMutableArray *descriptions = [NSMutableArray array];
    if (!findMatches(params, refs, descriptions)) { *failure = @"No window was readable."; return nil; }
    if (refs.count == 0) { *failure = @"No control matched that selector."; return nil; }

    NSString *value = params[@"value"] ?: @"";
    AXUIElementRef element = (__bridge AXUIElementRef)refs.firstObject;
    AXError set = AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFTypeRef)value);
    if (set == kAXErrorSuccess) return @{ @"set": @YES, @"value": value };

    if (AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue) != kAXErrorSuccess) {
        *failure = @"That control did not accept a value and could not be focused.";
        return nil;
    }
    usleep(80000);
    inputSendText(@{ @"text": value });
    return @{ @"set": @YES, @"value": value, @"method": @"typed" };
}

static NSDictionary *uiaQuery(NSDictionary *params, NSString **failure) {
    NSMutableArray *refs = [NSMutableArray array];
    NSMutableArray *descriptions = [NSMutableArray array];
    if (!findMatches(params, refs, descriptions)) { *failure = @"No window was readable."; return nil; }
    return @{ @"count": @(descriptions.count), @"elements": descriptions };
}

static BOOL performOne(AXUIElementRef element, NSDictionary *description, NSString *operation,
                       id value, NSString **failure) {
    NSDictionary *bounds = description[@"bounds"];
    CGPoint centre = CGPointMake([bounds[@"x"] doubleValue] + [bounds[@"width"] doubleValue] / 2,
                                 [bounds[@"y"] doubleValue] + [bounds[@"height"] doubleValue] / 2);
    BOOL onScreen = [bounds[@"width"] doubleValue] > 0 && [bounds[@"height"] doubleValue] > 0;

    if ([operation isEqualToString:@"click"] || [operation isEqualToString:@"select"]
        || [operation isEqualToString:@"check"] || [operation isEqualToString:@"uncheck"]
        || [operation isEqualToString:@"toggle"]) {
        if ([operation isEqualToString:@"check"] && [description[@"checked"] boolValue]) return YES;
        if ([operation isEqualToString:@"uncheck"] && ![description[@"checked"] boolValue]) return YES;
        if (AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess) return YES;
        if (!onScreen) { *failure = @"That control cannot be pressed and has no on-screen position."; return NO; }
        inputClick(@{ @"x": @(centre.x), @"y": @(centre.y) });
        return YES;
    }
    if ([operation isEqualToString:@"doubleClick"]) {
        if (!onScreen) { *failure = @"That control has no on-screen position."; return NO; }
        inputClick(@{ @"x": @(centre.x), @"y": @(centre.y), @"double": @YES });
        return YES;
    }
    if ([operation isEqualToString:@"contextClick"]) {
        if (!onScreen) { *failure = @"That control has no on-screen position."; return NO; }
        inputClick(@{ @"x": @(centre.x), @"y": @(centre.y), @"button": @"right" });
        return YES;
    }
    if ([operation isEqualToString:@"hover"]) {
        if (!onScreen) { *failure = @"That control has no on-screen position."; return NO; }
        CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, centre, kCGMouseButtonLeft);
        CGEventPost(kCGHIDEventTap, move);
        CFRelease(move);
        markSyntheticEvent();
        return YES;
    }
    if ([operation isEqualToString:@"focus"]) {
        return AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue) == kAXErrorSuccess;
    }
    if ([operation isEqualToString:@"fill"] || [operation isEqualToString:@"type"] || [operation isEqualToString:@"clear"]) {
        NSString *text = [operation isEqualToString:@"clear"] ? @"" : (value ? [NSString stringWithFormat:@"%@", value] : @"");
        if (AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFTypeRef)text) == kAXErrorSuccess) return YES;
        if (AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue) != kAXErrorSuccess) {
            *failure = @"That control did not accept a value and could not be focused.";
            return NO;
        }
        usleep(80000);
        inputSendText(@{ @"text": text });
        return YES;
    }
    if ([operation isEqualToString:@"expand"] || [operation isEqualToString:@"collapse"]) {
        CFBooleanRef wanted = [operation isEqualToString:@"expand"] ? kCFBooleanTrue : kCFBooleanFalse;
        if (AXUIElementSetAttributeValue(element, kAXExpandedAttribute, wanted) == kAXErrorSuccess) return YES;
        return AXUIElementPerformAction(element, kAXShowMenuAction) == kAXErrorSuccess;
    }
    if ([operation isEqualToString:@"scrollIntoView"]) {
        return AXUIElementPerformAction(element, CFSTR("AXScrollToVisible")) == kAXErrorSuccess;
    }
    *failure = [NSString stringWithFormat:@"%@ is not an operation this helper can perform.", operation];
    return NO;
}

static NSDictionary *uiaPerform(NSDictionary *params, NSString **failure) {
    NSMutableArray *refs = [NSMutableArray array];
    NSMutableArray *descriptions = [NSMutableArray array];
    if (!findMatches(params, refs, descriptions)) { *failure = @"No window was readable."; return nil; }
    if (refs.count == 0) { *failure = @"No control matched that selector."; return nil; }

    NSString *operation = params[@"operation"] ?: @"click";
    NSMutableArray *results = [NSMutableArray array];
    for (NSUInteger index = 0; index < refs.count; index++) {
        NSString *problem = nil;
        BOOL ok = performOne((__bridge AXUIElementRef)refs[index], descriptions[index],
                             operation, params[@"value"], &problem);
        [results addObject:@{ @"name": descriptions[index][@"name"] ?: @"", @"ok": @(ok),
                              @"error": problem ?: [NSNull null] }];
        if (!ok && refs.count == 1) { *failure = problem; return nil; }
        usleep(60000);
    }
    return @{ @"count": @(results.count), @"results": results };
}

static NSDictionary *uiaAssert(NSDictionary *params, NSString **failure) {
    NSMutableArray *refs = [NSMutableArray array];
    NSMutableArray *descriptions = [NSMutableArray array];
    if (!findMatches(params, refs, descriptions)) { *failure = @"No window was readable."; return nil; }

    NSString *assertion = params[@"assertion"] ?: @"exists";
    id expected = params[@"expected"];
    NSString *expectedText = expected ? [NSString stringWithFormat:@"%@", expected] : @"";
    NSUInteger count = descriptions.count;
    NSDictionary *first = count ? descriptions.firstObject : nil;
    NSString *actual = first ? ([first[@"value"] length] ? first[@"value"] : first[@"name"]) : @"";

    BOOL passed = NO;
    if ([assertion isEqualToString:@"exists"]) passed = count > 0;
    else if ([assertion isEqualToString:@"notExists"]) passed = count == 0;
    else if ([assertion isEqualToString:@"countEquals"]) passed = count == (NSUInteger)[expected integerValue];
    else if ([assertion isEqualToString:@"countAtLeast"]) passed = count >= (NSUInteger)[expected integerValue];
    else if ([assertion isEqualToString:@"equals"]) passed = [actual isEqualToString:expectedText];
    else if ([assertion isEqualToString:@"notEquals"]) passed = ![actual isEqualToString:expectedText];
    else if ([assertion isEqualToString:@"contains"]) passed = [actual rangeOfString:expectedText options:NSCaseInsensitiveSearch].location != NSNotFound;
    else if ([assertion isEqualToString:@"matches"]) {
        NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:expectedText options:0 error:nil];
        passed = pattern && [pattern numberOfMatchesInString:actual options:0 range:NSMakeRange(0, actual.length)] > 0;
    }
    else if ([assertion isEqualToString:@"nonEmpty"]) passed = actual.length > 0;
    else if ([assertion isEqualToString:@"visible"]) passed = count > 0 && ![first[@"offscreen"] boolValue];
    else if ([assertion isEqualToString:@"hidden"]) passed = count == 0 || [first[@"offscreen"] boolValue];
    else if ([assertion isEqualToString:@"enabled"]) passed = count > 0 && [first[@"enabled"] boolValue];
    else if ([assertion isEqualToString:@"disabled"]) passed = count > 0 && ![first[@"enabled"] boolValue];
    else if ([assertion isEqualToString:@"selected"]) passed = count > 0 && [first[@"selected"] boolValue];
    else if ([assertion isEqualToString:@"checked"]) passed = count > 0 && [first[@"checked"] boolValue];
    else if ([assertion isEqualToString:@"unchecked"]) passed = count > 0 && ![first[@"checked"] boolValue];
    else { *failure = [NSString stringWithFormat:@"%@ is not an assertion this helper can check.", assertion]; return nil; }

    return @{ @"passed": @(passed), @"actual": actual ?: @"", @"count": @(count) };
}

static NSDictionary *windowsForeground(void) {
    pid_t pid = frontmostPid();
    if (!pid) return nil;

    NSString *title = @"";
    AXUIElementRef window = copyFocusedWindow(pid);
    if (window) {
        title = axString(window, kAXTitleAttribute);
        CFRelease(window);
    }
    if (!title.length) {
        for (NSDictionary *entry in windowsList(@{ @"visibleOnly": @YES })) {
            if ([entry[@"processId"] intValue] == pid) { title = entry[@"title"] ?: @""; break; }
        }
    }
    if (!title.length) title = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].localizedName ?: @"";
    return @{ @"title": title, @"processId": @(pid) };
}

static void handleNativeCall(NSString *identifier, NSDictionary *params) {
    NSString *method = params[@"native_method"] ?: @"";
    NSDictionary *arguments = params[@"native_params"] ?: @{};

    BOOL needsAccessibility = ([method hasPrefix:@"input."] && ![method isEqualToString:@"input.lastActivity"]) || [method hasPrefix:@"uia."] || [method isEqualToString:@"windows.focus"];
    if (needsAccessibility && !hasAccessibility()) {
        emitError(identifier, @"AccessibilityDenied",
                  @"OmniAgent needs Accessibility permission to control this Mac. Open System Settings > Privacy & Security > Accessibility and switch OmniAgent on.");
        return;
    }

    if ([method isEqualToString:@"input.lastActivity"]) { emitOk(identifier, inputLastActivity()); return; }
    if ([method isEqualToString:@"input.click"]) { emitOk(identifier, inputClick(arguments)); return; }
    if ([method isEqualToString:@"input.sendText"]) { emitOk(identifier, inputSendText(arguments)); return; }
    if ([method isEqualToString:@"input.scroll"]) { emitOk(identifier, inputScroll(arguments)); return; }
    if ([method isEqualToString:@"windows.list"]) { emitOk(identifier, @{ @"windows": windowsList(arguments) }); return; }
    if ([method isEqualToString:@"windows.foreground"]) {
        NSDictionary *front = windowsForeground();
        if (front) emitOk(identifier, front);
        else emitError(identifier, @"NoForegroundWindow", @"No application is in front.");
        return;
    }
    if ([method isEqualToString:@"windows.focus"]) {
        NSString *failure = nil;
        NSDictionary *result = windowsFocus(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"WindowNotFound", failure);
        return;
    }
    if ([method isEqualToString:@"uia.snapshot"]) {
        NSMutableArray *refs = [NSMutableArray array];
        NSDictionary *snapshot = uiaSnapshot(arguments, refs);
        if (snapshot) emitOk(identifier, snapshot);
        else emitError(identifier, @"NoWindow", @"No readable window is in front. Use open_app to start a program, then try again.");
        return;
    }
    if ([method isEqualToString:@"uia.invoke"] || [method isEqualToString:@"uia.select"]) {
        NSString *failure = nil;
        NSDictionary *result = uiaInvoke(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"ElementNotFound", failure);
        return;
    }
    if ([method isEqualToString:@"uia.setValue"]) {
        NSString *failure = nil;
        NSDictionary *result = uiaSetValue(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"ElementNotFound", failure);
        return;
    }
    if ([method isEqualToString:@"uia.perform"]) {
        NSString *failure = nil;
        NSDictionary *result = uiaPerform(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"PerformFailed", failure);
        return;
    }
    if ([method isEqualToString:@"uia.assert"]) {
        NSString *failure = nil;
        NSDictionary *result = uiaAssert(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"AssertFailed", failure);
        return;
    }
    if ([method isEqualToString:@"uia.query"]) {
        NSString *failure = nil;
        NSDictionary *result = uiaQuery(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"ElementNotFound", failure);
        return;
    }
    if ([method isEqualToString:@"input.sendKey"]) {
        NSString *failure = nil;
        NSDictionary *result = inputSendKey(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"UnsupportedKey", failure);
        return;
    }
    if ([method isEqualToString:@"screen.capture"]) {
        NSString *failure = nil;
        NSDictionary *result = screenCapture(arguments, &failure);
        if (result) emitOk(identifier, result); else emitError(identifier, @"CaptureFailed", failure);
        return;
    }
    emitError(identifier, @"UnsupportedMethod", [NSString stringWithFormat:@"%@ is not implemented by the macOS helper yet.", method]);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc > 1 && strcmp(argv[1], "--probe") == 0) {
            emit(@{ @"accessibility": @(hasAccessibility()) });
            return 0;
        }
        setvbuf(stdout, NULL, _IOLBF, 0);
        char *line = NULL;
        size_t capacity = 0;
        ssize_t length = 0;
        while ((length = getline(&line, &capacity, stdin)) > 0) {
            @autoreleasepool {
                NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
                NSDictionary *message = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                if (![message isKindOfClass:NSDictionary.class]) continue;
                NSString *identifier = message[@"id"] ?: @"";
                NSString *method = message[@"method"] ?: @"";

                if ([method isEqualToString:@"health"]) {
                    emitOk(identifier, @{ @"name": @"OmniAgent macOS helper", @"version": @"1.0.0",
                                          @"python": [NSNull null], @"capabilities": @5,
                                          @"accessibility": @(hasAccessibility()) });
                } else if ([method isEqualToString:@"native.call"]) {
                    handleNativeCall(identifier, message[@"params"] ?: @{});
                } else if ([method isEqualToString:@"cancel"]) {
                    emitOk(identifier, @{ @"cancelled": @YES });
                } else {
                    emitError(identifier, @"UnknownMethod", [NSString stringWithFormat:@"Unknown method %@.", method]);
                }
            }
        }
        free(line);
    }
    return 0;
}
