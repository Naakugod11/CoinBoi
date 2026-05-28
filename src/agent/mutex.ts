// Single shared trade mutex. See spec §2.3.
// Serializes ONLY trade-issuing critical sections — reads stay concurrent.
// Both the decision loop and the safety loop import THIS instance.
import { Mutex } from 'async-mutex';

export const tradeMutex = new Mutex();
