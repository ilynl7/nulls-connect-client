#include "HTTPclient.h"
#include "../colorcodes.h"
#include <stdlib.h>
#include <string.h>

CURL *curl;

int http_client_init()
{
    curl = curl_easy_init();
    if (curl && curl_global_init(CURL_GLOBAL_DEFAULT))
        return 1;
    else
        return 0;
}

void http_client_destroy()
{
    curl_easy_cleanup(curl);
    curl_global_cleanup();
}

struct data
{
    char *memory;
    size_t size;
};

static size_t WriteMemoryCallback(void *contents, size_t size, size_t nmemb, void *userp)
{
    size_t realsize = size * nmemb;
    struct data *mem = (struct data *)userp;

    char *ptr = realloc(mem->memory, mem->size + realsize + 1);

    mem->memory = ptr;
    memcpy(&(mem->memory[mem->size]), contents, realsize);
    mem->size += realsize;
    mem->memory[mem->size] = 0;

    return realsize;
}

cJSON *GET_request_json(char *url, char *headers_arg[])
{
    curl_easy_reset(curl);
    struct curl_slist *headers = NULL;

    int i = 0;
    while (headers_arg[i] != NULL){
        headers = curl_slist_append(headers, headers_arg[i]);
        i++;
    }

    struct data chunk;
    chunk.memory = malloc(1);
    chunk.size = 0;

    CURLcode res;
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteMemoryCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, (void *)&chunk);

    res = curl_easy_perform(curl);

    cJSON *json = NULL;

    if (res == CURLE_OK)
        json = cJSON_Parse(chunk.memory);
    else
        fprintf(stderr, RED "failed: %s\n" RESET, curl_easy_strerror(res));

    curl_slist_free_all(headers);
    free(chunk.memory);

    return json;
}

cJSON *POST_request_json(char *url, char *headers_arg[], char data[])
{
    curl_easy_reset(curl);
    struct curl_slist *headers = NULL;

    int i = 0;
    while (headers_arg[i] != NULL){
        headers = curl_slist_append(headers, headers_arg[i]);
        i++;
    }

    struct data chunk;
    chunk.memory = malloc(1);
    chunk.size = 0;

    CURLcode res;
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteMemoryCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, (void *)&chunk);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, &data);

    res = curl_easy_perform(curl);

    cJSON *json = NULL;

    if (res == CURLE_OK)
        json = cJSON_Parse(chunk.memory);
    else
        fprintf(stderr, RED "failed: %s\n" RESET, curl_easy_strerror(res));

    curl_slist_free_all(headers);
    free(chunk.memory);

    return json;
}