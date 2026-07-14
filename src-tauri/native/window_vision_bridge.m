#import "window_vision_bridge.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <math.h>
#include <stdlib.h>
#include <string.h>

static const NSTimeInterval WVOperationTimeout = 8.0;
static const NSUInteger WVThumbnailSide = 32;

static char *WVJSONString(id object) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object ?: @{}
                                                   options:0
                                                     error:&error];
    if (!data) {
        NSString *fallback = @"{\"status\":\"failed\",\"error\":\"JSON encoding failed\"}";
        data = [fallback dataUsingEncoding:NSUTF8StringEncoding];
    }
    char *result = malloc(data.length + 1);
    if (!result) return NULL;
    memcpy(result, data.bytes, data.length);
    result[data.length] = '\0';
    return result;
}

static NSDictionary *WVError(NSString *message) {
    return @{ @"status": @"failed", @"error": message ?: @"Unknown error" };
}

static NSString *WVString(const char *value) {
    if (!value) return @"";
    return [NSString stringWithUTF8String:value] ?: @"";
}

static NSString *WVSafeName(NSString *value) {
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"];
    NSMutableString *result = [NSMutableString string];
    for (NSUInteger i = 0; i < value.length && result.length < 120; i++) {
        unichar c = [value characterAtIndex:i];
        [result appendString:[allowed characterIsMember:c]
            ? [NSString stringWithCharacters:&c length:1] : @"_"];
    }
    return result.length ? result : @"session";
}

static NSString *WVISODate(NSDate *date) {
    if (!date) return @"";
    static NSISO8601DateFormatter *formatter;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSISO8601DateFormatter alloc] init];
        formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                                  NSISO8601DateFormatWithFractionalSeconds;
    });
    return [formatter stringFromDate:date] ?: @"";
}

static SCShareableContent *WVFetchContent(NSError **outError) API_AVAILABLE(macos(12.3));
static SCShareableContent *WVFetchContent(NSError **outError) {
    __block SCShareableContent *content = nil;
    __block NSError *error = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                               onScreenWindowsOnly:NO
                                                 completionHandler:^(SCShareableContent *value, NSError *fetchError) {
        content = value;
        error = fetchError;
        dispatch_semaphore_signal(semaphore);
    }];
    long timedOut = dispatch_semaphore_wait(
        semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(WVOperationTimeout * NSEC_PER_SEC)));
    if (timedOut != 0 && !error) {
        error = [NSError errorWithDomain:@"com.mahi.window-vision" code:1
                                userInfo:@{NSLocalizedDescriptionKey: @"Timed out while listing windows"}];
    }
    if (outError) *outError = error;
    return content;
}

static SCWindow *WVWindowMatchingFilter(SCContentFilter *filter) API_AVAILABLE(macos(14.0));
static SCWindow *WVWindowMatchingFilter(SCContentFilter *filter) {
    CGRect target = filter.contentRect;
    if (target.size.width <= 0 || target.size.height <= 0) return nil;

    NSError *error = nil;
    SCShareableContent *content = WVFetchContent(&error);
    if (!content || error) return nil;

    SCWindow *match = nil;
    CGFloat bestScore = CGFLOAT_MAX;
    for (SCWindow *window in content.windows) {
        CGRect frame = window.frame;
        CGFloat dx = fabs(frame.origin.x - target.origin.x);
        CGFloat dy = fabs(frame.origin.y - target.origin.y);
        CGFloat dw = fabs(frame.size.width - target.size.width);
        CGFloat dh = fabs(frame.size.height - target.size.height);
        if (dx > 8 || dy > 8 || dw > 8 || dh > 8) continue;
        CGFloat score = dx + dy + dw + dh;
        if (score < bestScore) {
            match = window;
            bestScore = score;
        }
    }
    return match;
}

static NSString *WVRoleForWindow(SCWindow *window) API_AVAILABLE(macos(12.3));
static NSString *WVRoleForWindow(SCWindow *window) {
    NSString *title = window.title.lowercaseString ?: @"";
    NSArray<NSString *> *dialogWords = @[
        @"export", @"save", @"open", @"import", @"settings", @"preferences",
        @"render", @"properties", @"dialog", @"تنظیم", @"ذخیره", @"خروجی"
    ];
    for (NSString *word in dialogWords) {
        if ([title containsString:word]) return @"dialog";
    }
    BOOL active = NO;
    if (@available(macOS 13.1, *)) active = window.isActive;
    if (active || (window.frame.size.width >= 700 && window.frame.size.height >= 450)) {
        return @"main";
    }
    return @"panel";
}

static id WVDisplayForWindow(SCWindow *window, NSArray<SCDisplay *> *displays) API_AVAILABLE(macos(12.3));
static id WVDisplayForWindow(SCWindow *window, NSArray<SCDisplay *> *displays) {
    CGFloat bestArea = 0;
    NSNumber *best = nil;
    for (SCDisplay *display in displays) {
        CGRect intersection = CGRectIntersection(window.frame, display.frame);
        if (CGRectIsNull(intersection)) continue;
        CGFloat area = intersection.size.width * intersection.size.height;
        if (area > bestArea) {
            bestArea = area;
            best = @(display.displayID);
        }
    }
    return best ?: [NSNull null];
}

static NSDictionary *WVWindowDictionary(SCWindow *window, NSArray<SCDisplay *> *displays) API_AVAILABLE(macos(12.3));
static NSDictionary *WVWindowDictionary(SCWindow *window, NSArray<SCDisplay *> *displays) {
    SCRunningApplication *app = window.owningApplication;
    CGRect frame = window.frame;
    BOOL active = NO;
    if (@available(macOS 13.1, *)) active = window.isActive;
    return @{
        @"windowId": @(window.windowID),
        @"title": window.title ?: @"",
        @"bundleId": app.bundleIdentifier ?: @"",
        @"applicationName": app.applicationName ?: @"",
        @"processId": @(app.processID),
        @"displayId": WVDisplayForWindow(window, displays),
        @"role": WVRoleForWindow(window),
        @"isOnScreen": @(window.isOnScreen),
        @"isActive": @(active),
        @"layer": @(window.windowLayer),
        @"frame": @{
            @"x": @(frame.origin.x), @"y": @(frame.origin.y),
            @"width": @(frame.size.width), @"height": @(frame.size.height)
        }
    };
}

static SCStreamConfiguration *WVConfiguration(SCContentFilter *filter, CGRect fallbackRect,
                                               BOOL cursor, double fps) API_AVAILABLE(macos(12.3));
static SCStreamConfiguration *WVConfiguration(SCContentFilter *filter, CGRect fallbackRect,
                                               BOOL cursor, double fps) {
    CGRect rect = fallbackRect;
    double scale = 2.0;
    if (@available(macOS 14.0, *)) {
        SCShareableContentInfo *info = [SCShareableContent infoForFilter:filter];
        if (info.contentRect.size.width > 0 && info.contentRect.size.height > 0) {
            rect = info.contentRect;
        }
        if (info.pointPixelScale > 0) scale = info.pointPixelScale;
    }

    double width = MAX(64.0, ceil(rect.size.width * scale));
    double height = MAX(64.0, ceil(rect.size.height * scale));
    double largest = MAX(width, height);
    if (largest > 4096.0) {
        double ratio = 4096.0 / largest;
        width = floor(width * ratio);
        height = floor(height * ratio);
    }

    SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
    configuration.width = (size_t)width;
    configuration.height = (size_t)height;
    configuration.minimumFrameInterval = CMTimeMakeWithSeconds(1.0 / MAX(0.5, MIN(fps, 10.0)), 600);
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.scalesToFit = YES;
    configuration.showsCursor = cursor;
    configuration.queueDepth = 3;
    if (@available(macOS 13.0, *)) configuration.capturesAudio = NO;
    if (@available(macOS 14.0, *)) configuration.preservesAspectRatio = YES;
    if (@available(macOS 14.2, *)) configuration.includeChildWindows = YES;
    return configuration;
}

API_AVAILABLE(macos(12.3))
@interface MahiWVSession : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, readonly) NSString *sessionId;
@property(nonatomic, readonly) NSDictionary *metadata;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) CIContext *ciContext;
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic, strong) NSData *lastThumbnail;
@property(nonatomic, copy) NSString *latestPath;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) NSString *errorMessage;
@property(nonatomic, strong) NSDate *lastFrameAt;
@property(nonatomic, strong) NSDate *lastSeenAt;
@property(nonatomic) uint64_t revision;
@property(nonatomic) double changeScore;
@property(nonatomic) double threshold;
@property(nonatomic) NSUInteger frameWidth;
@property(nonatomic) NSUInteger frameHeight;
@property(nonatomic) dispatch_queue_t sampleQueue;
- (instancetype)initWithId:(NSString *)sessionId filter:(SCContentFilter *)filter
              configuration:(SCStreamConfiguration *)configuration
                   metadata:(NSDictionary *)metadata threshold:(double)threshold;
- (NSDictionary *)start;
- (NSDictionary *)stop;
- (NSDictionary *)snapshotSince:(uint64_t)revision;
- (NSDictionary *)waitAfter:(uint64_t)revision timeoutMs:(uint32_t)timeoutMs;
@end

@implementation MahiWVSession

- (instancetype)initWithId:(NSString *)sessionId filter:(SCContentFilter *)filter
              configuration:(SCStreamConfiguration *)configuration
                   metadata:(NSDictionary *)metadata threshold:(double)threshold {
    self = [super init];
    if (!self) return nil;
    _sessionId = [sessionId copy];
    _metadata = [metadata copy] ?: @{};
    _status = @"starting";
    _condition = [[NSCondition alloc] init];
    _ciContext = [CIContext contextWithOptions:@{ kCIContextUseSoftwareRenderer: @NO }];
    _threshold = MAX(0.001, MIN(threshold, 1.0));
    _sampleQueue = dispatch_queue_create(
        [[NSString stringWithFormat:@"com.mahi.window-vision.%@", sessionId] UTF8String],
        DISPATCH_QUEUE_SERIAL);
    _stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:self];
    return self;
}

- (NSString *)cachePath {
    NSString *root = [NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES) firstObject];
    NSString *directory = [[root stringByAppendingPathComponent:@"com.sinatorabi.vibe-coder"]
        stringByAppendingPathComponent:@"window-vision"];
    directory = [directory stringByAppendingPathComponent:WVSafeName(self.sessionId)];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory
                              withIntermediateDirectories:YES
                                               attributes:@{NSFilePosixPermissions: @0700}
                                                    error:nil];
    return [directory stringByAppendingPathComponent:@"latest.png"];
}

- (NSDictionary *)start {
    NSError *outputError = nil;
    if (![self.stream addStreamOutput:self type:SCStreamOutputTypeScreen
                   sampleHandlerQueue:self.sampleQueue error:&outputError]) {
        self.status = @"failed";
        self.errorMessage = outputError.localizedDescription ?: @"Unable to attach capture output";
        return [self snapshotSince:0];
    }

    __block NSError *startError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [self.stream startCaptureWithCompletionHandler:^(NSError *error) {
        startError = error;
        dispatch_semaphore_signal(semaphore);
    }];
    long timedOut = dispatch_semaphore_wait(
        semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(WVOperationTimeout * NSEC_PER_SEC)));
    [self.condition lock];
    if (timedOut != 0) {
        self.status = @"failed";
        self.errorMessage = @"Timed out while starting capture";
    } else if (startError) {
        self.status = @"failed";
        self.errorMessage = startError.localizedDescription ?: @"Unable to start capture";
    } else {
        self.status = @"active";
        self.lastSeenAt = [NSDate date];
    }
    [self.condition broadcast];
    [self.condition unlock];
    return [self snapshotSince:0];
}

- (NSDictionary *)stop {
    [self.condition lock];
    BOOL alreadyStopped = [self.status isEqualToString:@"stopped"];
    [self.condition unlock];
    if (!alreadyStopped) {
        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
        [self.stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {
            dispatch_semaphore_signal(semaphore);
        }];
        dispatch_semaphore_wait(
            semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.0 * NSEC_PER_SEC)));
    }
    [self.condition lock];
    self.status = @"stopped";
    [self.condition broadcast];
    [self.condition unlock];
    return [self snapshotSince:0];
}

- (NSData *)thumbnailForPixelBuffer:(CVPixelBufferRef)pixelBuffer {
    CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    size_t width = CVPixelBufferGetWidth(pixelBuffer);
    size_t height = CVPixelBufferGetHeight(pixelBuffer);
    size_t rowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer);
    const uint8_t *base = CVPixelBufferGetBaseAddress(pixelBuffer);
    NSMutableData *data = [NSMutableData dataWithLength:WVThumbnailSide * WVThumbnailSide];
    uint8_t *target = data.mutableBytes;
    if (base && width && height) {
        for (NSUInteger y = 0; y < WVThumbnailSide; y++) {
            size_t sourceY = MIN(height - 1, (y * height) / WVThumbnailSide);
            const uint8_t *row = base + sourceY * rowBytes;
            for (NSUInteger x = 0; x < WVThumbnailSide; x++) {
                size_t sourceX = MIN(width - 1, (x * width) / WVThumbnailSide);
                const uint8_t *pixel = row + sourceX * 4;
                target[y * WVThumbnailSide + x] =
                    (uint8_t)((29 * pixel[0] + 150 * pixel[1] + 77 * pixel[2]) >> 8);
            }
        }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    return data;
}

- (double)scoreForThumbnail:(NSData *)thumbnail {
    if (!self.lastThumbnail || self.lastThumbnail.length != thumbnail.length) return 1.0;
    const uint8_t *oldBytes = self.lastThumbnail.bytes;
    const uint8_t *newBytes = thumbnail.bytes;
    uint64_t total = 0;
    for (NSUInteger i = 0; i < thumbnail.length; i++) {
        total += (uint64_t)abs((int)newBytes[i] - (int)oldBytes[i]);
    }
    return (double)total / ((double)thumbnail.length * 255.0);
}

- (BOOL)writePixelBuffer:(CVPixelBufferRef)pixelBuffer error:(NSError **)outError {
    CIImage *image = [CIImage imageWithCVPixelBuffer:pixelBuffer];
    CGImageRef cgImage = [self.ciContext createCGImage:image fromRect:image.extent];
    if (!cgImage) {
        if (outError) *outError = [NSError errorWithDomain:@"com.mahi.window-vision" code:2
            userInfo:@{NSLocalizedDescriptionKey: @"Unable to render captured frame"}];
        return NO;
    }
    NSBitmapImageRep *representation = [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
    CGImageRelease(cgImage);
    NSData *png = [representation representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png) {
        if (outError) *outError = [NSError errorWithDomain:@"com.mahi.window-vision" code:3
            userInfo:@{NSLocalizedDescriptionKey: @"Unable to encode captured frame"}];
        return NO;
    }
    NSString *path = [self cachePath];
    BOOL written = [png writeToFile:path options:NSDataWritingAtomic error:outError];
    if (written) self.latestPath = path;
    return written;
}

- (void)stream:(__unused SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sampleBuffer)) return;

    SCFrameStatus frameStatus = SCFrameStatusComplete;
    CFArrayRef attachmentArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
    if (attachmentArray && CFArrayGetCount(attachmentArray) > 0) {
        NSDictionary *attachments = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachmentArray, 0);
        NSNumber *value = attachments[SCStreamFrameInfoStatus];
        if (value) frameStatus = (SCFrameStatus)value.integerValue;
    }

    [self.condition lock];
    self.lastSeenAt = [NSDate date];
    if (frameStatus == SCFrameStatusBlank || frameStatus == SCFrameStatusSuspended) {
        self.status = @"stale";
        [self.condition broadcast];
        [self.condition unlock];
        return;
    }
    [self.condition unlock];

    if (frameStatus != SCFrameStatusComplete && frameStatus != SCFrameStatusStarted) return;
    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!pixelBuffer) return;

    NSData *thumbnail = [self thumbnailForPixelBuffer:pixelBuffer];
    [self.condition lock];
    double score = [self scoreForThumbnail:thumbnail];
    BOOL meaningful = !self.lastThumbnail || score >= self.threshold;
    self.lastThumbnail = thumbnail;
    self.status = @"active";
    self.lastFrameAt = [NSDate date];
    self.frameWidth = CVPixelBufferGetWidth(pixelBuffer);
    self.frameHeight = CVPixelBufferGetHeight(pixelBuffer);
    [self.condition unlock];

    if (!meaningful) return;
    NSError *writeError = nil;
    BOOL written = [self writePixelBuffer:pixelBuffer error:&writeError];
    [self.condition lock];
    if (written) {
        self.revision += 1;
        self.changeScore = score;
    } else {
        self.errorMessage = writeError.localizedDescription ?: @"Unable to save captured frame";
    }
    [self.condition broadcast];
    [self.condition unlock];
}

- (void)stream:(__unused SCStream *)stream didStopWithError:(NSError *)error {
    [self.condition lock];
    self.status = @"failed";
    self.errorMessage = error.localizedDescription ?: @"Capture stream stopped";
    [self.condition broadcast];
    [self.condition unlock];
}

- (NSDictionary *)snapshotSince:(uint64_t)sinceRevision {
    [self.condition lock];
    NSString *status = self.status ?: @"failed";
    if ([status isEqualToString:@"active"] && self.lastSeenAt &&
        -[self.lastSeenAt timeIntervalSinceNow] > 2.5) {
        status = @"stale";
    }
    NSMutableDictionary *result = [@{
        @"status": status,
        @"sessionId": self.sessionId,
        @"revision": @(self.revision),
        @"changed": @(self.revision > sinceRevision),
        @"changeScore": @(self.changeScore),
        @"width": @(self.frameWidth),
        @"height": @(self.frameHeight),
        @"lastFrameAt": WVISODate(self.lastFrameAt),
        @"imagePath": self.latestPath ?: @"",
        @"metadata": self.metadata ?: @{}
    } mutableCopy];
    if (self.errorMessage.length) result[@"error"] = self.errorMessage;
    [self.condition unlock];
    return result;
}

- (NSDictionary *)waitAfter:(uint64_t)afterRevision timeoutMs:(uint32_t)timeoutMs {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:MIN(timeoutMs, 30000) / 1000.0];
    [self.condition lock];
    while (self.revision <= afterRevision &&
           ([self.status isEqualToString:@"active"] || [self.status isEqualToString:@"starting"] ||
            [self.status isEqualToString:@"stale"])) {
        if (![self.condition waitUntilDate:deadline]) break;
    }
    [self.condition unlock];
    return [self snapshotSince:afterRevision];
}

@end

API_AVAILABLE(macos(12.3))
@interface MahiWVManager : NSObject <SCContentSharingPickerObserver>
@property(nonatomic, strong) NSMutableDictionary<NSString *, MahiWVSession *> *sessions;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *pickerResults;
@property(nonatomic, copy) NSString *pendingPickerSessionId;
@property(nonatomic, copy) NSString *pendingPickerMode;
@property(nonatomic) BOOL pickerObserverRegistered;
+ (instancetype)shared;
- (NSDictionary *)startSession:(NSString *)sessionId filter:(SCContentFilter *)filter
                      fallback:(CGRect)fallback metadata:(NSDictionary *)metadata
                        cursor:(BOOL)cursor fps:(double)fps threshold:(double)threshold;
@end

@implementation MahiWVManager

+ (instancetype)shared {
    static MahiWVManager *manager;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ manager = [[MahiWVManager alloc] init]; });
    return manager;
}

- (instancetype)init {
    self = [super init];
    if (!self) return nil;
    _sessions = [NSMutableDictionary dictionary];
    _pickerResults = [NSMutableDictionary dictionary];
    [self cleanupCache];
    return self;
}

- (void)cleanupCache {
    NSString *root = [NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES) firstObject];
    NSString *directory = [[root stringByAppendingPathComponent:@"com.sinatorabi.vibe-coder"]
        stringByAppendingPathComponent:@"window-vision"];
    NSArray<NSString *> *items = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil];
    NSDate *cutoff = [NSDate dateWithTimeIntervalSinceNow:-600];
    for (NSString *item in items) {
        NSString *path = [directory stringByAppendingPathComponent:item];
        NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
        if ([attributes.fileModificationDate compare:cutoff] == NSOrderedAscending) {
            [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
        }
    }
}

- (NSDictionary *)startSession:(NSString *)sessionId filter:(SCContentFilter *)filter
                      fallback:(CGRect)fallback metadata:(NSDictionary *)metadata
                        cursor:(BOOL)cursor fps:(double)fps threshold:(double)threshold {
    MahiWVSession *previous = nil;
    @synchronized (self) { previous = self.sessions[sessionId]; }
    if (previous) [previous stop];

    SCStreamConfiguration *configuration = WVConfiguration(filter, fallback, cursor, fps);
    MahiWVSession *session = [[MahiWVSession alloc] initWithId:sessionId filter:filter
        configuration:configuration metadata:metadata threshold:threshold];
    @synchronized (self) { self.sessions[sessionId] = session; }
    NSDictionary *result = [session start];
    if ([result[@"status"] isEqualToString:@"failed"]) {
        @synchronized (self) { [self.sessions removeObjectForKey:sessionId]; }
    }
    return result;
}

- (void)contentSharingPicker:(__unused SCContentSharingPicker *)picker
          didCancelForStream:(__unused SCStream *)stream API_AVAILABLE(macos(14.0)) {
    @synchronized (self) {
        if (!self.pendingPickerSessionId.length) return;
        NSString *sessionId = self.pendingPickerSessionId;
        self.pickerResults[sessionId] = @{ @"status": @"cancelled", @"sessionId": sessionId };
        self.pendingPickerSessionId = nil;
        self.pendingPickerMode = nil;
    }
}

- (void)contentSharingPicker:(__unused SCContentSharingPicker *)picker
         didUpdateWithFilter:(SCContentFilter *)filter
                   forStream:(__unused SCStream *)stream API_AVAILABLE(macos(14.0)) {
    NSString *sessionId = nil;
    NSString *pickerMode = nil;
    @synchronized (self) {
        if (!self.pendingPickerSessionId.length) return;
        sessionId = self.pendingPickerSessionId;
        pickerMode = self.pendingPickerMode ?: @"window";
        self.pickerResults[sessionId] = @{ @"status": @"starting", @"sessionId": sessionId };
        self.pendingPickerSessionId = nil;
        self.pendingPickerMode = nil;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSMutableOrderedSet<NSString *> *bundleIds = [NSMutableOrderedSet orderedSet];
        NSMutableArray<NSNumber *> *windowIds = [NSMutableArray array];
        if (@available(macOS 15.2, *)) {
            for (SCRunningApplication *app in filter.includedApplications) {
                if (app.bundleIdentifier.length) [bundleIds addObject:app.bundleIdentifier];
            }
            for (SCWindow *window in filter.includedWindows) {
                [windowIds addObject:@(window.windowID)];
                if (window.owningApplication.bundleIdentifier.length) {
                    [bundleIds addObject:window.owningApplication.bundleIdentifier];
                }
            }
        } else if ([pickerMode isEqualToString:@"window"]) {
            // Before macOS 15.2 the selected objects are not exposed by the
            // filter. The picker is limited to one window on those systems,
            // so resolve only an exact frame match and never guess an app.
            SCWindow *window = WVWindowMatchingFilter(filter);
            if (window) {
                [windowIds addObject:@(window.windowID)];
                if (window.owningApplication.bundleIdentifier.length) {
                    [bundleIds addObject:window.owningApplication.bundleIdentifier];
                }
            }
        }
        NSDictionary *metadata = @{
            @"mode": [pickerMode isEqualToString:@"display"] ? @"display_picker" : @"picker",
            @"bundleIds": bundleIds.array,
            @"windowIds": windowIds
        };
        NSDictionary *session = [self startSession:sessionId filter:filter
            fallback:CGRectMake(0, 0, 1280, 720) metadata:metadata
            cursor:NO fps:1.0 threshold:0.03];
        NSMutableDictionary *result = [session mutableCopy];
        result[@"pickerStatus"] = [session[@"status"] isEqualToString:@"failed"] ? @"failed" : @"selected";
        result[@"bundleIds"] = bundleIds.array;
        result[@"windowIds"] = windowIds;
        @synchronized (self) { self.pickerResults[sessionId] = result; }
    });
}

- (void)contentSharingPickerStartDidFailWithError:(NSError *)error API_AVAILABLE(macos(14.0)) {
    @synchronized (self) {
        if (!self.pendingPickerSessionId.length) return;
        NSString *sessionId = self.pendingPickerSessionId;
        self.pickerResults[sessionId] = @{
            @"status": @"failed", @"sessionId": sessionId,
            @"error": error.localizedDescription ?: @"Unable to open content picker"
        };
        self.pendingPickerSessionId = nil;
    }
}

@end

int mahi_wv_supported(void) {
    NSOperatingSystemVersion minimum = {12, 3, 0};
    return [[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:minimum] ? 1 : 0;
}

int mahi_wv_picker_supported(void) {
    NSOperatingSystemVersion minimum = {14, 0, 0};
    return [[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:minimum] ? 1 : 0;
}

int mahi_wv_permission_granted(void) {
    return CGPreflightScreenCaptureAccess() ? 1 : 0;
}

int mahi_wv_request_permission(void) {
    return CGRequestScreenCaptureAccess() ? 1 : 0;
}

char *mahi_wv_list_windows(void) {
    if (!mahi_wv_supported()) return WVJSONString(WVError(@"ScreenCaptureKit requires macOS 12.3 or newer"));
    NSError *error = nil;
    SCShareableContent *content = WVFetchContent(&error);
    if (!content) return WVJSONString(WVError(error.localizedDescription ?: @"Unable to list windows"));
    NSMutableArray *windows = [NSMutableArray array];
    for (SCWindow *window in content.windows) {
        if (!window.owningApplication.bundleIdentifier.length) continue;
        if (window.frame.size.width < 40 || window.frame.size.height < 30) continue;
        [windows addObject:WVWindowDictionary(window, content.displays)];
    }
    NSMutableArray *displays = [NSMutableArray array];
    for (SCDisplay *display in content.displays) {
        [displays addObject:@{
            @"displayId": @(display.displayID), @"width": @(display.width), @"height": @(display.height),
            @"frame": @{
                @"x": @(display.frame.origin.x), @"y": @(display.frame.origin.y),
                @"width": @(display.frame.size.width), @"height": @(display.frame.size.height)
            }
        }];
    }
    return WVJSONString(@{ @"status": @"ok", @"windows": windows, @"displays": displays });
}

char *mahi_wv_start_window(const char *rawSessionId, uint32_t windowId,
                           int includeCursor, double fps, double threshold) {
    NSString *sessionId = WVSafeName(WVString(rawSessionId));
    NSError *error = nil;
    SCShareableContent *content = WVFetchContent(&error);
    if (!content) return WVJSONString(WVError(error.localizedDescription ?: @"Unable to list windows"));
    SCWindow *selected = nil;
    for (SCWindow *window in content.windows) {
        if (window.windowID == windowId) { selected = window; break; }
    }
    if (!selected) return WVJSONString(WVError(@"Window is no longer available"));
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:selected];
    NSDictionary *metadata = @{
        @"mode": @"window",
        @"windowId": @(selected.windowID),
        @"windowIds": @[@(selected.windowID)],
        @"bundleId": selected.owningApplication.bundleIdentifier ?: @"",
        @"bundleIds": selected.owningApplication.bundleIdentifier ? @[selected.owningApplication.bundleIdentifier] : @[],
        @"title": selected.title ?: @"",
        @"role": WVRoleForWindow(selected),
        @"displayId": WVDisplayForWindow(selected, content.displays)
    };
    NSDictionary *result = [[MahiWVManager shared] startSession:sessionId filter:filter
        fallback:selected.frame metadata:metadata cursor:includeCursor != 0 fps:fps threshold:threshold];
    return WVJSONString(result);
}

char *mahi_wv_start_group(const char *rawSessionId, uint32_t displayId,
                          const char *rawWindowIds, int includeCursor,
                          double fps, double threshold) {
    NSString *sessionId = WVSafeName(WVString(rawSessionId));
    NSData *data = [WVString(rawWindowIds) dataUsingEncoding:NSUTF8StringEncoding];
    NSArray *ids = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![ids isKindOfClass:[NSArray class]] || ids.count == 0) {
        return WVJSONString(WVError(@"windowIds must contain at least one window"));
    }
    NSError *error = nil;
    SCShareableContent *content = WVFetchContent(&error);
    if (!content) return WVJSONString(WVError(error.localizedDescription ?: @"Unable to list windows"));
    SCDisplay *selectedDisplay = nil;
    for (SCDisplay *display in content.displays) {
        if (display.displayID == displayId) { selectedDisplay = display; break; }
    }
    if (!selectedDisplay) return WVJSONString(WVError(@"Display is no longer available"));
    NSSet<NSNumber *> *wanted = [NSSet setWithArray:ids];
    NSMutableArray<SCWindow *> *selectedWindows = [NSMutableArray array];
    NSMutableOrderedSet<NSString *> *bundleIds = [NSMutableOrderedSet orderedSet];
    for (SCWindow *window in content.windows) {
        if ([wanted containsObject:@(window.windowID)]) {
            [selectedWindows addObject:window];
            if (window.owningApplication.bundleIdentifier.length) {
                [bundleIds addObject:window.owningApplication.bundleIdentifier];
            }
        }
    }
    if (selectedWindows.count != wanted.count) {
        return WVJSONString(WVError(@"One or more windows are no longer available"));
    }
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:selectedDisplay
                                                      includingWindows:selectedWindows];
    NSDictionary *metadata = @{
        @"mode": @"group", @"displayId": @(selectedDisplay.displayID),
        @"windowIds": ids, @"bundleIds": bundleIds.array
    };
    NSDictionary *result = [[MahiWVManager shared] startSession:sessionId filter:filter
        fallback:selectedDisplay.frame metadata:metadata cursor:includeCursor != 0 fps:fps threshold:threshold];
    return WVJSONString(result);
}

char *mahi_wv_list_sessions(void) {
    NSMutableArray *sessions = [NSMutableArray array];
    MahiWVManager *manager = [MahiWVManager shared];
    @synchronized (manager) {
        for (MahiWVSession *session in manager.sessions.allValues) {
            [sessions addObject:[session snapshotSince:0]];
        }
    }
    return WVJSONString(@{ @"status": @"ok", @"sessions": sessions });
}

char *mahi_wv_capture(const char *rawSessionId, uint64_t sinceRevision) {
    NSString *sessionId = WVSafeName(WVString(rawSessionId));
    MahiWVSession *session = nil;
    MahiWVManager *manager = [MahiWVManager shared];
    @synchronized (manager) { session = manager.sessions[sessionId]; }
    if (!session) return WVJSONString(WVError(@"Observation session not found"));
    if (!session.latestPath.length) [session waitAfter:0 timeoutMs:2000];
    return WVJSONString([session snapshotSince:sinceRevision]);
}

char *mahi_wv_wait_for_change(const char *rawSessionId, uint64_t afterRevision,
                              uint32_t timeoutMs) {
    NSString *sessionId = WVSafeName(WVString(rawSessionId));
    MahiWVSession *session = nil;
    MahiWVManager *manager = [MahiWVManager shared];
    @synchronized (manager) { session = manager.sessions[sessionId]; }
    if (!session) return WVJSONString(WVError(@"Observation session not found"));
    return WVJSONString([session waitAfter:afterRevision timeoutMs:timeoutMs]);
}

char *mahi_wv_stop(const char *rawSessionId) {
    NSString *sessionId = WVSafeName(WVString(rawSessionId));
    MahiWVManager *manager = [MahiWVManager shared];
    MahiWVSession *session = nil;
    @synchronized (manager) {
        session = manager.sessions[sessionId];
        [manager.sessions removeObjectForKey:sessionId];
    }
    if (!session) return WVJSONString(@{ @"status": @"stopped", @"sessionId": sessionId });
    return WVJSONString([session stop]);
}

char *mahi_wv_stop_all(void) {
    MahiWVManager *manager = [MahiWVManager shared];
    NSArray<MahiWVSession *> *sessions = nil;
    @synchronized (manager) {
        sessions = manager.sessions.allValues;
        [manager.sessions removeAllObjects];
    }
    for (MahiWVSession *session in sessions) [session stop];
    return WVJSONString(@{ @"status": @"stopped", @"count": @(sessions.count) });
}

char *mahi_wv_present_picker(const char *rawSessionId, int displayMode) {
    NSString *sessionId = WVSafeName(WVString(rawSessionId));
    if (@available(macOS 14.0, *)) {
        MahiWVManager *manager = [MahiWVManager shared];
        @synchronized (manager) {
            if (manager.pendingPickerSessionId.length) {
                return WVJSONString(WVError(@"Another content picker is already open"));
            }
            manager.pendingPickerSessionId = sessionId;
            manager.pendingPickerMode = displayMode != 0 ? @"display" : @"window";
            manager.pickerResults[sessionId] = @{ @"status": @"pending", @"sessionId": sessionId };
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            SCContentSharingPicker *picker = SCContentSharingPicker.sharedPicker;
            SCContentSharingPickerConfiguration *configuration = [[SCContentSharingPickerConfiguration alloc] init];
            if (displayMode != 0) {
                configuration.allowedPickerModes = SCContentSharingPickerModeSingleDisplay;
            } else if (@available(macOS 15.2, *)) {
                configuration.allowedPickerModes = SCContentSharingPickerModeSingleWindow |
                    SCContentSharingPickerModeMultipleWindows |
                    SCContentSharingPickerModeSingleApplication;
            } else {
                configuration.allowedPickerModes = SCContentSharingPickerModeSingleWindow;
            }
            NSMutableArray<NSString *> *excluded = [@[
                @"com.sinatorabi.vibe-coder", @"com.apple.keychainaccess", @"com.apple.Passwords",
                @"com.apple.MobileSMS"
            ] mutableCopy];
            NSString *ownBundle = NSBundle.mainBundle.bundleIdentifier;
            if (ownBundle.length && ![excluded containsObject:ownBundle]) [excluded addObject:ownBundle];
            configuration.excludedBundleIDs = excluded;
            configuration.allowsChangingSelectedContent = NO;
            picker.defaultConfiguration = configuration;
            picker.maximumStreamCount = @8;
            picker.active = YES;
            if (!manager.pickerObserverRegistered) {
                [picker addObserver:manager];
                manager.pickerObserverRegistered = YES;
            }
            [picker presentPickerUsingContentStyle:
                displayMode != 0 ? SCShareableContentStyleDisplay : SCShareableContentStyleWindow];
        });
        return WVJSONString(@{ @"status": @"pending", @"sessionId": sessionId });
    }
    return WVJSONString(WVError(@"The system content picker requires macOS 14 or newer"));
}

char *mahi_wv_picker_result(const char *rawSessionId) {
    NSString *sessionId = WVSafeName(WVString(rawSessionId));
    MahiWVManager *manager = [MahiWVManager shared];
    NSDictionary *result = nil;
    @synchronized (manager) { result = manager.pickerResults[sessionId]; }
    return WVJSONString(result ?: WVError(@"Picker request not found"));
}

void mahi_wv_free_string(char *value) {
    free(value);
}
