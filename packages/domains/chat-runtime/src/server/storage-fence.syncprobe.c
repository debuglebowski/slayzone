#include <sqlite3ext.h>
#include <stdlib.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>
SQLITE_EXTENSION_INIT1
static sqlite3_vfs *base;
static sqlite3_vfs wrapped;
static pthread_t mainThread;
static atomic_int syncs;
static atomic_int total_syncs;
static atomic_int fail_next;
static atomic_int block_sync;
static atomic_int blocked;
typedef struct { sqlite3_io_methods methods; const sqlite3_io_methods *orig; } Methods;
static int syncProbe(sqlite3_file *f, int flags) {
  Methods *m=(Methods*)f->pMethods;
  atomic_fetch_add(&total_syncs, 1);
  if(pthread_equal(pthread_self(),mainThread)) atomic_fetch_add(&syncs, 1);
  if (atomic_exchange(&fail_next, 0)) return SQLITE_IOERR_FSYNC;
  if (atomic_load(&block_sync)) {
    atomic_store(&blocked, 1);
    const struct timespec pause = {0, 1000000};
    while (atomic_load(&block_sync)) nanosleep(&pause, NULL);
    atomic_store(&blocked, 0);
  }
  return m->orig->xSync(f,flags);
}
static int closeProbe(sqlite3_file *f) {
  Methods *m=(Methods*)f->pMethods;
  f->pMethods=m->orig;
  int rc=m->orig->xClose(f);
  free(m);
  return rc;
}
static int openProbe(sqlite3_vfs *v, const char *path, sqlite3_file *f, int flags, int *outFlags) {
  int rc=base->xOpen(base,path,f,flags,outFlags);
  if(rc==SQLITE_OK) {
    Methods *m=malloc(sizeof(*m));
    m->orig=f->pMethods;
    m->methods=*f->pMethods;
    m->methods.xSync=syncProbe;
    m->methods.xClose=closeProbe;
    f->pMethods=&m->methods;
  }
  return rc;
}
static void count(sqlite3_context *ctx,int argc,sqlite3_value **argv) { sqlite3_result_int(ctx,atomic_load(&syncs)); }
static void total(sqlite3_context *ctx,int argc,sqlite3_value **argv) { sqlite3_result_int(ctx,atomic_load(&total_syncs)); }
static void fail(sqlite3_context *ctx,int argc,sqlite3_value **argv) { atomic_store(&fail_next, 1); sqlite3_result_null(ctx); }
static void block(sqlite3_context *ctx,int argc,sqlite3_value **argv) { atomic_store(&block_sync, sqlite3_value_int(argv[0])); sqlite3_result_null(ctx); }
static void waiting(sqlite3_context *ctx,int argc,sqlite3_value **argv) { sqlite3_result_int(ctx, atomic_load(&blocked)); }
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_syncprobe_init(sqlite3 *db,char **err,const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  mainThread=pthread_self();
  base=sqlite3_vfs_find(NULL);
  wrapped=*base;
  wrapped.zName="fu2-sync-probe";
  wrapped.xOpen=openProbe;
  sqlite3_vfs_register(&wrapped,1);
  sqlite3_create_function(db,"sync_count",0,SQLITE_UTF8,0,count,0,0);
  sqlite3_create_function(db,"total_sync_count",0,SQLITE_UTF8,0,total,0,0);
  sqlite3_create_function(db,"fail_next_sync",0,SQLITE_UTF8,0,fail,0,0);
  sqlite3_create_function(db,"block_sync",1,SQLITE_UTF8,0,block,0,0);
  sqlite3_create_function(db,"sync_blocked",0,SQLITE_UTF8,0,waiting,0,0);
  return SQLITE_OK;
}
