#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "colorcodes.h"
#include "cJSON/cJSON.h"
#include "simpleHTTPclient/HTTPclient.h"
#include "menu/menu.h"

char *basic_common_headers[8] = {
    "Accept: application/json",
    "Origin: https://connect.nulls.gg",
    "Connection: keep-alive",
    "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    "Referer: https://connect.nulls.gg/",
    "Accept-Language: ru"};

char *construct_profile_url(char handle[], int lookup_type)
{
    static char url[144];
    char type[14];
    if (lookup_type == 1)
        strcpy(type, "Handle");
    else if (lookup_type == 2)
        strcpy(type, "GameAccountId");

    snprintf(url, sizeof(url), "https://profiles.dnull.xyz/laser/%s?lookup_type=%s", handle, type);

    return url;
}

char *construct_auth_url(char email[], int pin)
{
    static char url[171];

    if (pin == 0)
        snprintf(url, sizeof(url), "https://connect.nulls.gg/api/auth/login.v2?email=%s&game=laser&locale=ru", email);
    else
        snprintf(url, sizeof(url), "https://connect.nulls.gg/api/auth/login.v2?email=%s&game=laser&locale=ru&pin=%i", email, pin);

    return url;
}

void profile_menu()
{
    char *menu_items[] =
        {
            "Search by Handle",
            "Search by GameAccountId",
            "Update Handle",
            "Back to main menu"};

    int count = sizeof(menu_items) / sizeof(menu_items[0]);

    int option = create_menu_and_wait_for_choice(menu_items, GREEN "use ↑ ↓ to select the option\n" RESET, count);

    if (option == 4)
        return;

    char input[81];
    printf("\033[H\033[J");
    printf("\nenter the value > " GREEN);
    scanf("%80s", input);
    getchar();
    printf(RESET);

    char *OK[] = {"OK"};

    char *headers[] = {
        "Accept: application/json",
        NULL};
    if (option < 3)
    {
        cJSON *resp = GET_request_json(construct_profile_url(input, option), headers);

        char formatted_string[1024];

        cJSON *accountid = cJSON_GetObjectItemCaseSensitive(resp, "account_id");
        cJSON *gameaccountid = cJSON_GetObjectItemCaseSensitive(resp, "game_account_id");
        cJSON *handle = cJSON_GetObjectItemCaseSensitive(resp, "handle");
        cJSON *imageuuid = cJSON_GetObjectItemCaseSensitive(resp, "image_ref");

        

        if (!accountid)
        {
            char *str = cJSON_Print(resp);
            printf(RED);
            create_menu_and_wait_for_choice(OK, str, 1);
            printf(RESET);
            free(str);
        }
        else
        {
            snprintf(formatted_string, sizeof(formatted_string), GREEN "Profile info:" RESET YELLOW "\n  accountId: %s\n  gameAccountId: %s\n  handle: %s\n  image uuid: %s\n\n" RESET, accountid->valuestring, gameaccountid->valuestring, handle->valuestring, imageuuid->valuestring);

            create_menu_and_wait_for_choice(OK, formatted_string, 1);
        }
        cJSON_Delete(resp);
    }
    else
    {
        char input1[1024];
        printf("\nenter ur acc token > " GREEN);
        scanf("%1023s", input1);
        getchar();
        char auth_header[1100];

        basic_common_headers[6] = auth_header;
        basic_common_headers[7] = NULL;

        snprintf(auth_header, sizeof(auth_header), "Authorization: Bearer %s", input1);

        char url[256];

        snprintf(url, sizeof(url), "https://profiles.dnull.xyz/update?handle=%s&image_ref=83a9523b-d954-4311-a62e-3ca8971403e1", input);

        char data[] = "{}";

        cJSON *resp = POST_request_json(url, basic_common_headers, data);

        char *str = cJSON_Print(resp);
        printf(GREEN);
        create_menu_and_wait_for_choice(OK, str, 1);
        printf(RESET);
        free(str);
    }
}

void account_managment_menu(char token[])
{
    char *OK[] = {"OK"};

    char auth_header[1100];
    snprintf(auth_header, sizeof(auth_header), "Authorization: Bearer %s", token);

    free(token);

    basic_common_headers[6] = auth_header;
    basic_common_headers[7] = NULL;

    char *menu_items[] =
        {
            "Linked accounts",
            "Refresh tokens",
            "Back to NConnect menu"};

    int count = sizeof(menu_items) / sizeof(menu_items[0]);

    while (1)
    {

        int option = create_menu_and_wait_for_choice(menu_items, GREEN "use ↑ ↓ to select the option\n" RESET, count);

        if (option == 3)
            break;
        else if (option == 1)
        {
            cJSON *resp = GET_request_json("https://connect.nulls.gg/api/games/links?game=laser", basic_common_headers);

            cJSON *links = cJSON_GetObjectItemCaseSensitive(resp, "links");

            if (links == NULL)
            {
                create_menu_and_wait_for_choice(OK, RED "Invalid token!" RESET, 1);
                continue;
            }

            char **accounts = malloc((cJSON_GetArraySize(links) + 1) * sizeof(char *));

            cJSON *item = NULL;

            int i = 0;
            cJSON_ArrayForEach(item, links)
            {
                cJSON *info = cJSON_GetObjectItemCaseSensitive(item, "player_info");
                cJSON *name = cJSON_GetObjectItemCaseSensitive(info, "name");
                accounts[i] = name->valuestring;
                i++;
            }

            accounts[i] = "Back to account managment menu";

            int acc_index = create_menu_and_wait_for_choice(accounts, GREEN "use ↑ ↓ to select the account and press enter for view its info\n" RESET, cJSON_GetArraySize(links) + 1) - 1;

            if (acc_index == i)
            {
                free(accounts);
                cJSON_Delete(resp);
                continue;
            }

            item = cJSON_GetArrayItem(links, acc_index);

            cJSON *id = cJSON_GetObjectItemCaseSensitive(item, "player_id");

            cJSON *info = cJSON_GetObjectItemCaseSensitive(item, "player_info");
            cJSON *tag = cJSON_GetObjectItemCaseSensitive(info, "tag");
            cJSON *name = cJSON_GetObjectItemCaseSensitive(info, "name");
            cJSON *score = cJSON_GetObjectItemCaseSensitive(info, "score");

            char formatted_string[1024];

            snprintf(formatted_string, sizeof(formatted_string), GREEN "Account info:" RESET YELLOW "\n  id: %s\n  tag: %s\n  name: %s\n  score: %i\n\n" RESET, id->valuestring, tag->valuestring, name->valuestring, score->valueint);

            char *yey[] = {"Account token", "Back to account managment menu"};
            int chose = create_menu_and_wait_for_choice(yey, formatted_string, 2);

            if (chose == 2)
            {
                free(accounts);
                cJSON_Delete(resp);
                continue;
            }
            else if (chose == 1)
            {
                char url[80];
                char acc_token[1024];
                snprintf(url, sizeof(url), "https://connect.nulls.gg/api/games/token?player_id=%s&game=laser", id->valuestring);
                cJSON *resp = GET_request_json(url, basic_common_headers);
                cJSON *token = cJSON_GetObjectItemCaseSensitive(resp, "token");

                snprintf(acc_token, sizeof(acc_token), GREEN "ur token: \n" RESET YELLOW "%s\n\n" RESET, token->valuestring);

                create_menu_and_wait_for_choice(OK, acc_token, 1);

                cJSON_Delete(resp);
            }

            free(accounts);
            cJSON_Delete(resp);
        }
        else if (option == 2)
        {
            cJSON *resp = GET_request_json("https://connect.nulls.gg/api/games/refresh_tokens", basic_common_headers);
            cJSON_Delete(resp);
            create_menu_and_wait_for_choice(OK, GREEN "Successfully!" RESET, 1);
        }
    }
}

void NConnect_menu()
{
    char *menu_items[] =
        {
            "Get auth token",
            "Account management",
            "Back to main menu"};

    int count = sizeof(menu_items) / sizeof(menu_items[0]);

    while (1)
    {
        int option = create_menu_and_wait_for_choice(menu_items, GREEN "use ↑ ↓ to select the option\n" RESET, count);

        if (option == 3)
            break;

        int code = 0;
        char *input = malloc(1);

        printf("\033[H\033[J");

        if (option == 1)
        {
            input = realloc(input, 100);
            printf("\nenter ur email addres > " GREEN);
            scanf("%100s", input);
        }
        else if (option == 2)
        {
            input = realloc(input, 1024);
            printf("\nenter ur auth token > " GREEN);
            scanf("%1024s", input);
            getchar();
        }
        printf(RESET);

        if (option == 1)
        {
            basic_common_headers[6] = NULL;

            cJSON *resp1 = GET_request_json(construct_auth_url(input, 0), basic_common_headers);

            char *OK[] = {"OK"};

            cJSON *pin_required = cJSON_GetObjectItemCaseSensitive(resp1, "pin_required");
            if (pin_required)
            {
                printf("enter the code > " GREEN);
                scanf("%6i", &code);
                getchar();
                printf(RESET);

                char token_str[1024];

                cJSON *resp2 = GET_request_json(construct_auth_url(input, code), basic_common_headers);

                free(input);

                cJSON *token = cJSON_GetObjectItemCaseSensitive(resp2, "token");
                if (token != NULL)
                    snprintf(token_str, sizeof(token_str), GREEN "ur token: \n" RESET YELLOW "%s\n\n" RESET, token->valuestring);
                else
                    snprintf(token_str, sizeof(token_str), RED "Invalid code!" RESET);

                cJSON_Delete(resp2);
                cJSON_Delete(resp1);
                create_menu_and_wait_for_choice(OK, token_str, 1);
                continue;
            }
            else
            {
                free(input);
                create_menu_and_wait_for_choice(OK, RED "Invalid email!" RESET, 1);
                continue;
            }

            cJSON_Delete(resp1);
        }
        else if (option == 2)
        {
            account_managment_menu(input);
        }
    }
}

int main()
{
    http_client_init();

    char *menu_items[] = {
        "NConnect API",
        "Profile API",
        "Exit"};

    int count = sizeof(menu_items) / sizeof(menu_items[0]);

    while (1)
    {
        int option = create_menu_and_wait_for_choice(menu_items, GREEN "Hello!\nuse ↑ ↓ to select the option\n" RESET, count);

        if (option == 3)
            return 0;
        else if (option == 2)
            profile_menu();
        else if (option == 1)
            NConnect_menu();
    }
    http_client_destroy();
    return 0;
}