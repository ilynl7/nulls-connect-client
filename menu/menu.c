#include "menu.h"
#include "../colorcodes.h"
#include <stdio.h>

#define KEY_UP 1
#define KEY_DOWN 2
#ifdef _WIN32
#include <conio.h>
#define KEY_ENTER 13
#else
#include <termios.h>
#include <unistd.h>
#define KEY_ENTER 10
#endif

void clear_console() {
  printf("\033[H\033[J");
}

int getch(void) {
  int ch;
#ifdef _WIN32
  ch = _getch();
#else
  struct termios oldt, newt;
  tcgetattr(STDIN_FILENO, &oldt);
  newt = oldt;
  newt.c_lflag &= ~(ICANON | ECHO);
  tcsetattr(STDIN_FILENO, TCSANOW, &newt);
  ch = getchar();
  tcsetattr(STDIN_FILENO, TCSANOW, &oldt);
#endif
  return ch;
}

void update_menu(char *options[], int selected, char *header,
                 int options_count) {
  clear_console();

  printf("%s\n", header);

  for (int i = 0; i < options_count; i++) {
    if (i == selected) {
      printf(GREEN " > " REVERSE " %s " RESET "\n", options[i]);
    } else {
      printf("   %s \n", options[i]);
    }
  }
}

int create_menu_and_wait_for_choice(char *options[], char *header, int options_count) {
  int selected = 0;
  int key;

  while (1) {
    update_menu(options, selected, header, options_count);
    key = getch();
    if (key == 27 || key ==  224 || key ==  0) {
      key = getch();
      if (key == 91) {
        switch (getch())
        {
          case 65: key = KEY_UP; break;
          case 66: key = KEY_DOWN; break;
        }
      }
      else if (key == 72){
        key = KEY_UP;
      }
      else if (key == 80){
        key = KEY_DOWN;
      }
    }

    if (key == KEY_UP) {
      selected = (selected > 0) ? selected - 1 : options_count - 1;
    } else if (key == KEY_DOWN) {
      selected = (selected < options_count - 1) ? selected + 1 : 0;
    } else if (key == KEY_ENTER) {
      return selected + 1;
    }
  }
}
