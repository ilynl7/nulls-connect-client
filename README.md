# nulls-connect-client
simple nulls connect account management tool written in C.

## Requirements:
* gcc
* curl
## Instructions
1. write following in the console:
```
mkdir output & gcc ./cJSON/cJSON.c ./simpleHTTPclient/HTTPclient.c ./menu/menu.c -lcurl ./main.c -o ./output/main
```
2. Launch executable:
* on linux:
  ```
  ./output/main
  ```
* on windows:
  ```
  ./output/main.exe
  ```
  WARNING: On Windows gui may not work as expected.
