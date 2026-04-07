#ifndef HTTPCLIENT_H
#define HTTPCLIENT_H

#include "../cJSON/cJSON.h"
#include <curl/curl.h>

typedef struct {
    char *memory;
    size_t size;
} data_t;

int http_client_init();

void http_client_destroy();

cJSON *GET_request_json(char *url, char *headers_arg[]);
cJSON *POST_request_json(char *url, char *headers_arg[], char data[]);

#endif