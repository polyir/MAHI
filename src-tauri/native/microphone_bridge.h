#ifndef MAHI_MICROPHONE_BRIDGE_H
#define MAHI_MICROPHONE_BRIDGE_H

char *mahi_mic_start(const char *path);
char *mahi_mic_level(void);
char *mahi_mic_stop(void);
void mahi_mic_free_string(char *value);

#endif
