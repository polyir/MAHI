#import "microphone_bridge.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>

#include <stdlib.h>
#include <string.h>

static char *MicJSON(id object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object ?: @{} options:0 error:nil];
    if (!data) data = [@"{\"status\":\"failed\",\"error\":\"JSON encoding failed\"}"
        dataUsingEncoding:NSUTF8StringEncoding];
    char *result = malloc(data.length + 1);
    if (!result) return NULL;
    memcpy(result, data.bytes, data.length);
    result[data.length] = '\0';
    return result;
}

static NSDictionary *MicError(NSString *message) {
    return @{ @"status": @"failed", @"error": message ?: @"Microphone recording failed" };
}

@interface MahiMicrophoneRecorder : NSObject
@property(nonatomic, strong) AVAudioRecorder *recorder;
@property(nonatomic, copy) NSString *path;
+ (instancetype)shared;
@end

@implementation MahiMicrophoneRecorder

+ (instancetype)shared {
    static MahiMicrophoneRecorder *instance;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ instance = [[MahiMicrophoneRecorder alloc] init]; });
    return instance;
}

@end

static BOOL MicEnsurePermission(NSString **message) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status == AVAuthorizationStatusAuthorized) return YES;
    if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) {
        if (message) *message = @"Microphone access is disabled in System Settings";
        return NO;
    }

    __block BOOL granted = NO;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allowed) {
        granted = allowed;
        dispatch_semaphore_signal(semaphore);
    }];
    long timedOut = dispatch_semaphore_wait(
        semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)));
    if (timedOut != 0 && message) *message = @"Timed out while requesting microphone access";
    if (!granted && timedOut == 0 && message) *message = @"Microphone access was denied";
    return granted;
}

char *mahi_mic_start(const char *rawPath) {
    NSString *path = rawPath ? [NSString stringWithUTF8String:rawPath] : nil;
    if (!path.length) return MicJSON(MicError(@"Invalid microphone recording path"));

    MahiMicrophoneRecorder *manager = [MahiMicrophoneRecorder shared];
    @synchronized (manager) {
        if (manager.recorder.isRecording) {
            return MicJSON(MicError(@"A microphone recording is already active"));
        }
    }

    NSString *permissionError = nil;
    if (!MicEnsurePermission(&permissionError)) return MicJSON(MicError(permissionError));

    NSDictionary *settings = @{
        AVFormatIDKey: @(kAudioFormatMPEG4AAC),
        AVSampleRateKey: @44100,
        AVNumberOfChannelsKey: @1,
        AVEncoderBitRateKey: @64000,
        AVEncoderAudioQualityKey: @(AVAudioQualityHigh)
    };
    NSError *error = nil;
    AVAudioRecorder *recorder = [[AVAudioRecorder alloc]
        initWithURL:[NSURL fileURLWithPath:path] settings:settings error:&error];
    if (!recorder || error) return MicJSON(MicError(error.localizedDescription));
    recorder.meteringEnabled = YES;
    if (![recorder prepareToRecord] || ![recorder record]) {
        return MicJSON(MicError(@"Unable to start microphone recording"));
    }

    @synchronized (manager) {
        manager.recorder = recorder;
        manager.path = path;
    }
    return MicJSON(@{ @"status": @"recording", @"path": path });
}

char *mahi_mic_stop(void) {
    MahiMicrophoneRecorder *manager = [MahiMicrophoneRecorder shared];
    AVAudioRecorder *recorder = nil;
    NSString *path = nil;
    @synchronized (manager) {
        recorder = manager.recorder;
        path = manager.path;
        manager.recorder = nil;
        manager.path = nil;
    }
    if (!recorder) return MicJSON(MicError(@"No microphone recording is active"));
    [recorder stop];

    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    if (attributes.fileSize == 0) return MicJSON(MicError(@"The microphone recording is empty"));
    return MicJSON(@{
        @"status": @"stopped", @"path": path ?: @"",
        @"duration": @(recorder.currentTime), @"mimeType": @"audio/mp4"
    });
}

char *mahi_mic_level(void) {
    MahiMicrophoneRecorder *manager = [MahiMicrophoneRecorder shared];
    AVAudioRecorder *recorder = nil;
    @synchronized (manager) { recorder = manager.recorder; }
    if (!recorder.isRecording) return MicJSON(MicError(@"No microphone recording is active"));

    [recorder updateMeters];
    float averageDb = [recorder averagePowerForChannel:0];
    float peakDb = [recorder peakPowerForChannel:0];
    // AVAudioRecorder reports dBFS. Map the useful voice range (-60…0 dB)
    // to a stable UI envelope while preserving actual microphone dynamics.
    double level = MAX(0.0, MIN(1.0, (averageDb + 60.0) / 60.0));
    double peak = MAX(0.0, MIN(1.0, (peakDb + 60.0) / 60.0));
    return MicJSON(@{
        @"status": @"recording", @"level": @(level), @"peak": @(peak),
        @"averageDb": @(averageDb), @"peakDb": @(peakDb)
    });
}

void mahi_mic_free_string(char *value) {
    free(value);
}
