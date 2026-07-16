#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static void die_errno(const char *label) {
  fprintf(stderr, "uid-peer-helper: %s: %s\n", label, strerror(errno));
  exit(1);
}

static void usage(const char *argv0) {
  fprintf(stderr, "usage: %s --accept-once <socket-path> [--socket-mode <octal>]\n", argv0);
}

static void json_string(FILE *out, const char *value, ssize_t len) {
  fputc('"', out);
  for (ssize_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)value[i];
    switch (c) {
      case '\\':
        fputs("\\\\", out);
        break;
      case '"':
        fputs("\\\"", out);
        break;
      case '\n':
        fputs("\\n", out);
        break;
      case '\r':
        fputs("\\r", out);
        break;
      case '\t':
        fputs("\\t", out);
        break;
      default:
        if (c < 0x20) {
          fprintf(out, "\\u%04x", c);
        } else {
          fputc(c, out);
        }
    }
  }
  fputc('"', out);
}

static int parse_octal_mode(const char *value, mode_t *mode) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 8);
  if (errno != 0 || end == value || *end != '\0' || parsed > 0777) {
    return -1;
  }
  *mode = (mode_t)parsed;
  return 0;
}

int main(int argc, char **argv) {
  if ((argc != 3 && argc != 5) || strcmp(argv[1], "--accept-once") != 0) {
    usage(argv[0]);
    return 2;
  }

  const char *socket_path = argv[2];
  mode_t socket_mode = 0660;
  if (argc == 5) {
    if (strcmp(argv[3], "--socket-mode") != 0 || parse_octal_mode(argv[4], &socket_mode) != 0) {
      usage(argv[0]);
      return 2;
    }
  }

  if (strlen(socket_path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
    fprintf(stderr, "uid-peer-helper: socket path too long\n");
    return 2;
  }

  signal(SIGPIPE, SIG_IGN);

  int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server_fd < 0) {
    die_errno("socket(AF_UNIX, SOCK_STREAM)");
  }

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, socket_path, sizeof(addr.sun_path) - 1);

  unlink(socket_path);
  if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    die_errno("bind");
  }
  if (chmod(socket_path, socket_mode) != 0) {
    die_errno("chmod");
  }
  if (listen(server_fd, 1) != 0) {
    die_errno("listen");
  }

  fprintf(stderr, "uid-peer-helper: primitive=getpeereid(3)\n");
  fprintf(stderr, "uid-peer-helper: listening path=%s\n", socket_path);
  fflush(stderr);

  int client_fd = accept(server_fd, NULL, NULL);
  if (client_fd < 0) {
    die_errno("accept");
  }

  uid_t uid;
  gid_t gid;
  if (getpeereid(client_fd, &uid, &gid) != 0) {
    die_errno("getpeereid");
  }

  char payload[8192];
  ssize_t payload_len = read(client_fd, payload, sizeof(payload) - 1);
  if (payload_len < 0) {
    die_errno("read");
  }
  payload[payload_len] = '\0';

  printf("{\"ok\":true,\"primitive\":\"getpeereid(3)\",\"uid\":%u,\"gid\":%u,\"payload\":",
    (unsigned int)uid,
    (unsigned int)gid);
  json_string(stdout, payload, payload_len);
  puts("}");
  fflush(stdout);

  close(client_fd);
  close(server_fd);
  unlink(socket_path);
  return 0;
}
