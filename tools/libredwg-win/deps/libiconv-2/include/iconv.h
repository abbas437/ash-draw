/* Minimal declarations of the GNU libiconv 1.x API as exported by the MSYS2
   libiconv-2.dll shipped in the upstream LibreDWG win64 zip (only the three
   entry points LibreDWG uses). GNU libiconv names its symbols libiconv_*. */
#ifndef _LIBICONV_H
#define _LIBICONV_H
#include <stddef.h>
#include <errno.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef void *iconv_t;
#define iconv_open libiconv_open
#define iconv libiconv
#define iconv_close libiconv_close
extern iconv_t iconv_open (const char *tocode, const char *fromcode);
extern size_t iconv (iconv_t cd, char **inbuf, size_t *inbytesleft,
                     char **outbuf, size_t *outbytesleft);
extern int iconv_close (iconv_t cd);
#ifdef __cplusplus
}
#endif
#endif
