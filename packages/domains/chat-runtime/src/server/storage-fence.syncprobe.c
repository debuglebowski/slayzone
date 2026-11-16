#include <sqlite3ext.h>
#include <stdlib.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>
#include <string.h>
SQLITE_EXTENSION_INIT1
static sqlite3_vfs *base;
static sqlite3_vfs wrapped;
static pthread_t mainThread;
static atomic_int syncs;
static atomic_int total_syncs;
static atomic_int fail_next;
static atomic_int block_sync;
static atomic_int blocked;
static atomic_int initialized;
static atomic_int target_set;
static pthread_t targetThread;
static atomic_int block_copy;
static atomic_int copy_blocked;
static atomic_int copy_files;
typedef struct { sqlite3_io_methods methods; const sqlite3_io_methods *orig; int copy; } Methods;
static int syncProbe(sqlite3_file *f, int flags) {
  Methods *m=(Methods*)f->pMethods;
  atomic_fetch_add(&total_syncs, 1);
  if(pthread_equal(pthread_self(),mainThread)) atomic_fetch_add(&syncs, 1);
  int targeted = !atomic_load(&target_set) || pthread_equal(pthread_self(),targetThread);
  if (targeted && atomic_exchange(&fail_next, 0)) return SQLITE_IOERR_FSYNC;
  if (m->copy && atomic_load(&block_copy)) {
    atomic_fetch_add(&copy_blocked, 1);
    const struct timespec pause = {0, 1000000};
    while (atomic_load(&block_copy)) nanosleep(&pause, NULL);
    atomic_fetch_sub(&copy_blocked, 1);
  }
  if (targeted && atomic_load(&block_sync)) {
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
  if (m->copy) atomic_fetch_sub(&copy_files, 1);
  free(m);
  return rc;
}
static int openProbe(sqlite3_vfs *v, const char *path, sqlite3_file *f, int flags, int *outFlags) {
  int rc=base->xOpen(base,path,f,flags,outFlags);
  if(rc==SQLITE_OK) {
    Methods *m=malloc(sizeof(*m));
    m->orig=f->pMethods;
    m->copy=path && strstr(path, ".compact-") != NULL;
    if (m->copy) atomic_fetch_add(&copy_files, 1);
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
static void target(sqlite3_context *ctx,int argc,sqlite3_value **argv) {
  atomic_store(&target_set, 0);
  if (sqlite3_value_int(argv[0])) { targetThread=pthread_self(); atomic_store(&target_set, 1); }
  sqlite3_result_null(ctx);
}
static void copyBlock(sqlite3_context *ctx,int argc,sqlite3_value **argv) { atomic_store(&block_copy, sqlite3_value_int(argv[0])); sqlite3_result_null(ctx); }
static void copyWaiting(sqlite3_context *ctx,int argc,sqlite3_value **argv) { sqlite3_result_int(ctx, atomic_load(&copy_blocked)); }
static void copyFiles(sqlite3_context *ctx,int argc,sqlite3_value **argv) { sqlite3_result_int(ctx, atomic_load(&copy_files)); }
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_syncprobe_init(sqlite3 *db,char **err,const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  if (!atomic_exchange(&initialized, 1)) {
    mainThread=pthread_self();
    base=sqlite3_vfs_find(NULL);
    wrapped=*base;
    wrapped.zName="fu2-sync-probe";
    wrapped.xOpen=openProbe;
    sqlite3_vfs_register(&wrapped,1);
  }
  sqlite3_create_function(db,"sync_count",0,SQLITE_UTF8,0,count,0,0);
  sqlite3_create_function(db,"total_sync_count",0,SQLITE_UTF8,0,total,0,0);
  sqlite3_create_function(db,"fail_next_sync",0,SQLITE_UTF8,0,fail,0,0);
  sqlite3_create_function(db,"block_sync",1,SQLITE_UTF8,0,block,0,0);
  sqlite3_create_function(db,"sync_blocked",0,SQLITE_UTF8,0,waiting,0,0);
  sqlite3_create_function(db,"target_sync_thread",1,SQLITE_UTF8,0,target,0,0);
  sqlite3_create_function(db,"block_copy_sync",1,SQLITE_UTF8,0,copyBlock,0,0);
  sqlite3_create_function(db,"copy_sync_blocked",0,SQLITE_UTF8,0,copyWaiting,0,0);
  sqlite3_create_function(db,"copy_files",0,SQLITE_UTF8,0,copyFiles,0,0);
  return SQLITE_OK;
}
