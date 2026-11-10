#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#include <sys/stat.h>
#include <stdio.h>
#include <errno.h>

static AVAudioPlayer *player;
static NSString *currentId;
static float volume = 0.18f;
static NSError *failure(NSString *message) { return [NSError errorWithDomain:@"Organizer" code:1 userInfo:@{NSLocalizedDescriptionKey:message}]; }
static NSDictionary *inspect(NSString *filePath, NSError **error) {
    struct stat st;
    if (lstat(filePath.fileSystemRepresentation, &st) != 0) { *error=failure([NSString stringWithUTF8String:strerror(errno)]); return nil; }
    NSURL *url=[NSURL fileURLWithPath:filePath];
    NSArray *keys=@[NSURLIsPackageKey,NSURLIsAliasFileKey,NSURLIsUbiquitousItemKey,NSURLUbiquitousItemDownloadingStatusKey,NSURLVolumeUUIDStringKey];
    NSDictionary *r=[url resourceValuesForKeys:keys error:error]; if (!r) return nil;
    BOOL ubiquitous=[r[NSURLIsUbiquitousItemKey] boolValue];
    NSString *status=r[NSURLUbiquitousItemDownloadingStatusKey];
    BOOL cloud=(st.st_flags & 0x40000000) || (st.st_flags & 0x00000080) || (ubiquitous && [status isEqualToString:NSURLUbiquitousItemDownloadingStatusNotDownloaded]);
    BOOL unknown=ubiquitous && !status && !cloud;
    return @{ @"links":@(st.st_nlink), @"regular":(st.st_mode&S_IFMT)==S_IFREG?@YES:@NO, @"directory":(st.st_mode&S_IFMT)==S_IFDIR?@YES:@NO, @"package":[r[NSURLIsPackageKey] boolValue]?@YES:@NO, @"alias":[r[NSURLIsAliasFileKey] boolValue]?@YES:@NO, @"cloudOnly":cloud?@YES:@NO, @"availabilityUnknown":unknown?@YES:@NO,
        @"device":[NSString stringWithFormat:@"%d",st.st_dev], @"inode":[NSString stringWithFormat:@"%llu",st.st_ino], @"birth":[NSString stringWithFormat:@"%ld:%ld",st.st_birthtimespec.tv_sec,st.st_birthtimespec.tv_nsec], @"size":@(st.st_size), @"mtime":[NSString stringWithFormat:@"%ld:%ld",st.st_mtimespec.tv_sec,st.st_mtimespec.tv_nsec], @"ctime":[NSString stringWithFormat:@"%ld:%ld",st.st_ctimespec.tv_sec,st.st_ctimespec.tv_nsec], @"volume":r[NSURLVolumeUUIDStringKey]?:[NSNull null] };
}
static NSDictionary *state(void) { return @{@"fileId":currentId?:[NSNull null],@"playing":@(player.isPlaying),@"position":@(player.currentTime),@"duration":@(player.duration),@"volume":@(volume),@"error":[NSNull null]}; }
static id handle(NSDictionary *r,NSError **error) {
    NSString *command=r[@"command"];
    if (![command isKindOfClass:NSString.class]) { *error=failure(@"Missing command."); return nil; }
    if ([command isEqualToString:@"inspect"] || [command isEqualToString:@"load"]) {
        NSString *filePath=r[@"path"];
        if (![filePath isKindOfClass:NSString.class] || ![filePath hasPrefix:@"/"]) { *error=failure(@"Invalid file path."); return nil; }
        NSDictionary *info=inspect(filePath,error); if(!info)return nil;
        if([command isEqualToString:@"inspect"])return info;
        NSString *fileId=r[@"fileId"];
        if (![fileId isKindOfClass:NSString.class] || ![info[@"regular"] boolValue] || [info[@"alias"] boolValue] || [info[@"cloudOnly"] boolValue] || [info[@"availabilityUnknown"] boolValue]) { *error=failure(@"This file is not safely available locally."); return nil; }
        [player stop]; player=nil; currentId=nil;
        AVAudioPlayer *next=[[AVAudioPlayer alloc] initWithContentsOfURL:[NSURL fileURLWithPath:filePath] error:error];
        if(!next)return nil; next.volume=volume; [next prepareToPlay]; player=next; currentId=fileId;return state();
    }
    if([command isEqualToString:@"trash"] || [command isEqualToString:@"restore"]) {
        NSString *filePath=r[@"path"]; NSDictionary *expected=r[@"expected"];
        if(![filePath isKindOfClass:NSString.class] || ![filePath hasPrefix:@"/"] || ![expected isKindOfClass:NSDictionary.class]) { *error=failure(@"Invalid cleanup request.");return nil; }
        NSURL *url=[NSURL fileURLWithPath:filePath];
        if(![url.URLByResolvingSymlinksInPath.path isEqualToString:filePath]) { *error=failure(@"Cleanup path contains a symbolic link.");return nil; }
        NSDictionary *info=inspect(filePath,error);if(!info)return nil;
        if(![info[@"regular"] boolValue] || [info[@"alias"] boolValue] || [info[@"cloudOnly"] boolValue] || [info[@"availabilityUnknown"] boolValue] || [info[@"links"] integerValue]!=1) { *error=failure(@"Cleanup requires a local regular file with one hard link.");return nil; }
        for(NSString *key in @[@"device",@"inode",@"birth",@"size",@"mtime",@"ctime"]) if(![info[key] isEqual:expected[key]]) { *error=failure(@"File changed before cleanup. Nothing moved.");return nil; }
        if([command isEqualToString:@"trash"]) {
            NSURL *trashed=nil;
            if(![[NSFileManager defaultManager] trashItemAtURL:url resultingItemURL:&trashed error:error])return nil;
            return @{@"path":trashed.path?:@""};
        }
        NSString *destination=r[@"destination"];
        if(![destination isKindOfClass:NSString.class] || ![destination hasPrefix:@"/"]) { *error=failure(@"Invalid restore destination.");return nil; }
        NSString *parent=[destination stringByDeletingLastPathComponent];
        if(![[NSURL fileURLWithPath:parent].URLByResolvingSymlinksInPath.path isEqualToString:parent]) { *error=failure(@"Restore parent changed.");return nil; }
        if(![[NSFileManager defaultManager] moveItemAtURL:url toURL:[NSURL fileURLWithPath:destination] error:error])return nil;
        return @{@"path":destination};
    }
    if([command isEqualToString:@"play"]) {
        if(!player) { *error=failure(@"Select a local track first.");return nil; }
        if(player.currentTime>=player.duration)player.currentTime=0;
        if(![player play]) { *error=failure(@"macOS could not start audio playback.");return nil; }return state();
    }
    if([command isEqualToString:@"pause"]) { [player pause];return state(); }
    if([command isEqualToString:@"status"])return state();
    if([command isEqualToString:@"seek"] || [command isEqualToString:@"volume"]) {
        NSNumber *v=r[@"value"];
        if(![v isKindOfClass:NSNumber.class] || !isfinite(v.doubleValue) || v.doubleValue<0) { *error=failure(@"Invalid player value.");return nil; }
        if([command isEqualToString:@"seek"])player.currentTime=MIN(v.doubleValue,player.duration);
        else {if(v.doubleValue>1){*error=failure(@"Volume must be between 0 and 1.");return nil;}volume=v.floatValue;player.volume=volume;}
        return state();
    }
    *error=failure(@"Unsupported native-helper command.");return nil;
}
int main(void) {
    @autoreleasepool {
        char *line=NULL;size_t capacity=0;ssize_t length;
        while((length=getline(&line,&capacity,stdin))!=-1) {
            @autoreleasepool {
                NSError *error=nil;NSDictionary *request=nil;id value=nil;
                if(length>65536)error=failure(@"Input exceeded the helper limit.");
                else {NSData *data=[NSData dataWithBytes:line length:(NSUInteger)length];id parsed=[NSJSONSerialization JSONObjectWithData:data options:0 error:&error];if([parsed isKindOfClass:NSDictionary.class])request=parsed;else if(!error)error=failure(@"Invalid request.");}
                NSNumber *requestId=request[@"id"];
                if(![requestId isKindOfClass:NSNumber.class]){requestId=@0;if(!error)error=failure(@"Missing request ID.");}
                if(!error)value=handle(request,&error);
                NSDictionary *response=error?@{@"id":requestId,@"ok":@NO,@"error":error.localizedDescription}:@{@"id":requestId,@"ok":@YES,@"value":value?:[NSNull null]};
                NSData *data=[NSJSONSerialization dataWithJSONObject:response options:NSJSONWritingSortedKeys error:nil];
                fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);
            }
        }
        free(line);[player stop];
    }
    return 0;
}
