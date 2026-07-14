#ifndef MAHI_WINDOW_VISION_BRIDGE_H
#define MAHI_WINDOW_VISION_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int mahi_wv_supported(void);
int mahi_wv_picker_supported(void);
int mahi_wv_permission_granted(void);
int mahi_wv_request_permission(void);

char *mahi_wv_list_windows(void);
char *mahi_wv_list_sessions(void);
char *mahi_wv_start_window(const char *session_id, uint32_t window_id,
                           int include_cursor, double fps, double threshold);
char *mahi_wv_start_group(const char *session_id, uint32_t display_id,
                          const char *window_ids_json, int include_cursor,
                          double fps, double threshold);
char *mahi_wv_capture(const char *session_id, uint64_t since_revision);
char *mahi_wv_wait_for_change(const char *session_id, uint64_t after_revision,
                              uint32_t timeout_ms);
char *mahi_wv_stop(const char *session_id);
char *mahi_wv_stop_all(void);

char *mahi_wv_present_picker(const char *session_id, int display_mode);
char *mahi_wv_picker_result(const char *session_id);

void mahi_wv_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif
