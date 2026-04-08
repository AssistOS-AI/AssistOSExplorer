/**
 * Kernel entry point.
 *
 * Re-exports the public surface of the middleware kernel so callers can
 * import everything from a single path:
 *
 *     import { compose, createKernelContext, abortSuccess } from '../runtime/kernel/index.mjs';
 *
 * Adding new kernel modules?  Re-export them here so consumers don't have
 * to know the internal layout.
 *
 * @module runtime/kernel
 */

export { compose } from './compose.mjs';
export { createKernelContext, forkKernelContext } from './context.mjs';
export {
    abortSuccess,
    abortError,
    createAbortApi,
    isKernelAbortSignal,
} from './abort.mjs';
export {
    createCanonicalStream,
    isCanonicalStream,
    tapStream,
    mapStream,
} from './canonical-stream.mjs';
export {
    bufferCanonicalStream,
    bufferingMiddleware,
    wrappingStreamMiddleware,
} from './response-buffer.mjs';
