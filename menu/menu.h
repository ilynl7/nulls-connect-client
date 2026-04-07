#ifndef MENU_H
#define MENU_H
#include "../utils/utils.h"

#define MENU_TITLE_GREEN(msg) GREEN msg "use ↑ ↓ to select the option\n" RESET
#define UNWRAP(...) __VA_ARGS__
#define MENU(prompt, items, body)                                              \
    do {                                                                       \
        char *_items[] = UNWRAP items;                                    \
        int _count = ARRAY_SIZE(_items);                                       \
        while (1) {                                                            \
            int _opt = create_menu_and_wait_for_choice(                        \
                _items, prompt, _count);                                       \
            if (_opt == _count) break;                                         \
            switch (_opt) body                                                 \
        }                                                                      \
    } while (0)

int create_menu_and_wait_for_choice(char *options[], char *header, int options_count);

#endif