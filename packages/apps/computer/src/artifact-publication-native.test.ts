import { expect, test } from 'vitest'
import {
  PUBLICATION_PROOF_TEST_TIMEOUT_MS,
  runPublicationProof
} from './artifact-publication-proof.fixture'

for (const mode of [
  'portable',
  'native',
  'public-native',
  'public-lifetimes',
  'public-fences',
  'public-attachments',
  'public-faults',
  'large',
  'faults',
  'relay',
  'range',
  'cache-count',
  'cache-budget',
  'cache-negative'
] as const) {
  test.skipIf(process.platform === 'win32')(
    `actual staged publication ${mode}: canonical files, physical lifetimes and native controls`,
    async () => {
      const result = await runPublicationProof(mode)
      if (mode === 'cache-negative') return
      expect(result).toMatchObject({ mode, actualPackagedWorker: true, mainSyncs: 0 })
      if (mode === 'native' || mode === 'public-native')
        expect(result).toMatchObject({
          finalPublicationFullFence: true,
          actorChecked: true,
          multiHubControls: true,
          failedFinalFenceUnconfirmed: true,
          zeroWholeWorkerBodyReads: true
        })
      if (mode === 'public-native')
        expect(result).toMatchObject({
          finalPublicInvoke: true,
          actualUploadManager: true,
          bodyReadNegativeControl: true
        })
      else if (mode === 'public-faults')
        expect(result).toMatchObject({
          sourceReadFailure: true,
          blobWorkingParentSyncFailures: true,
          previousVersionPreserved: true,
          actualCompactionSwapDrained: true,
          actualEpochAdvanced: true,
          mainBodyIo: 0
        })
      else if (mode === 'public-attachments')
        expect(result).toMatchObject({
          preparedAttachmentReplay: true,
          sharedAttachmentErasure: true,
          mainBodyIo: 0
        })
      else if (mode === 'public-fences')
        expect(result).toMatchObject({
          sourceIncarnation: true,
          epochFence: true,
          pauseReactivateFence: true,
          closeWhileReserving: true,
          mainBodyIo: 0
        })
      else if (mode === 'public-lifetimes')
        expect(result).toMatchObject({
          publicAbort: true,
          eraseWaited: true,
          failedCloseWaitedForExit: true,
          recoveredExactSource: true,
          mainBodyIo: 0
        })
      else if (mode === 'portable')
        expect(result).toMatchObject({
          cancelledQuiescent: true,
          fileSyncFailure: true,
          legacyMtimeTouch: true,
          eraseWaited: true,
          closeFailureWaitedForExit: true,
          beforeAndAfterCommitCrashRecovery: true
        })
      else if (mode === 'large')
        expect(result).toMatchObject({
          previousBytes: 64 * 1024 * 1024,
          appendedBytes: 32 * 1024 * 1024 + 17,
          wholeWorkerBodyReads: 0,
          mainBodyIo: 0
        })
      else if (mode === 'faults')
        expect(result).toMatchObject({
          sourceRead: true,
          blobSync: true,
          workingSync: true,
          parentSyncRollback: true,
          allBodyDescriptorsClosed: true,
          previousVersionPreserved: true
        })
      else if (mode === 'relay')
        expect(result).toMatchObject({
          notificationFailureRetainedOutbox: true,
          lostReplyMatchedSettlement: true,
          replayWithoutConsumedSource: true,
          noDuplicateMetadata: true
        })
      else if (mode === 'range')
        expect(result).toMatchObject({
          actualV9Dispatch: true,
          workingAndLegacyAndBlobRanges: true,
          exactGeneration: true,
          errorCodePreserved: true,
          closeWaitedForDescriptor: true,
          maxRead: 256 * 1024,
          mainBodyIo: 0,
          wholeWorkerBodyReads: 0
        })
      else if (mode.startsWith('cache-')) {
        expect(result).toMatchObject({
          retiredRequestsAndBodies: true,
          completedCountBound: true,
          completedCharacterBudget: true,
          matchedStatusCancelAfterPressure: true,
          replayAfterEviction: true,
          stagedLeaseAfterPressure: true
        })
        if (mode === 'cache-budget')
          expect(result).toMatchObject({
            absentWaitedForActualExit: true,
            longValidAuthorPreserved: true
          })
      }
    },
    PUBLICATION_PROOF_TEST_TIMEOUT_MS
  )
}
