import { defer, reject } from "rsvp";
import {
  yieldableSymbol,
  YIELDABLE_CONTINUE,
  YIELDABLE_THROW,
  YIELDABLE_RETURN,
  YIELDABLE_CANCEL,
  RawValue
} from "./utils.js";

const TASK_CANCELATION_NAME = "TaskCancelation";

const COMPLETION_PENDING = 0;
const COMPLETION_SUCCESS = 1;
const COMPLETION_ERROR = 2;
const COMPLETION_CANCEL = 3;

const GENERATOR_STATE_BEFORE_CREATE = "BEFORE_CREATE";
const GENERATOR_STATE_HAS_MORE_VALUES = "HAS_MORE_VALUES";
const GENERATOR_STATE_DONE = "DONE";
const GENERATOR_STATE_ERRORED = "ERRORED";

export const PERFORM_TYPE_DEFAULT = "PERFORM_TYPE_DEFAULT";
export const PERFORM_TYPE_UNLINKED = "PERFORM_TYPE_UNLINKED";
export const PERFORM_TYPE_LINKED = "PERFORM_TYPE_LINKED";

let TASK_INSTANCE_STACK = [];

export function getRunningInstance() {
  return TASK_INSTANCE_STACK[TASK_INSTANCE_STACK.length - 1];
}

function handleYieldedUnknownThenable(thenable, taskInstance, resumeIndex) {
  thenable.then(
    value => {
      taskInstance.proceed(resumeIndex, YIELDABLE_CONTINUE, value);
    },
    error => {
      taskInstance.proceed(resumeIndex, YIELDABLE_THROW, error);
    }
  );
}

/**
 * Returns true if the object passed to it is a TaskCancelation error.
 * If you call `someTask.perform().catch(...)` or otherwise treat
 * a {@linkcode TaskInstance} like a promise, you may need to
 * handle the cancelation of a TaskInstance differently from
 * other kinds of errors it might throw, and you can use this
 * convenience function to distinguish cancelation from errors.
 *
 * ```js
 * click() {
 *   this.get('myTask').perform().catch(e => {
 *     if (!didCancel(e)) { throw e; }
 *   });
 * }
 * ```
 *
 * @param {Object} error the caught error, which might be a TaskCancelation
 * @returns {Boolean}
 */
export function didCancel(e) {
  return e && e.name === TASK_CANCELATION_NAME;
}

function forwardToInternalPromise(method) {
  return function(...args) {
    this._hasSubscribed = true;
    return this._promise[method](...args);
  };
}

function spliceSlice(str, index, count, add) {
  return str.slice(0, index) + (add || "") + str.slice(index + count);
}

/**
  A `TaskInstance` represent a single execution of a
  {@linkcode Task}. Every call to {@linkcode Task#perform} returns
  a `TaskInstance`.

  `TaskInstance`s are cancelable, either explicitly
  via {@linkcode TaskInstance#cancel} or {@linkcode Task#cancelAll},
  or automatically due to the host object being destroyed, or
  because concurrency policy enforced by a
  {@linkcode TaskProperty Task Modifier} canceled the task instance.

  <style>
    .ignore-this--this-is-here-to-hide-constructor,
    #TaskInstance { display: none }
  </style>

  @class TaskInstance
*/
class TaskInstance {
  constructor({ fn, args, context, task }) {
    this.iterator = null;
    this._disposer = null;
    this._completionState = COMPLETION_PENDING;
    this.fn = fn;
    this.context = context;
    this.task = task || null;
    this.args = args || [];
    this._hasSubscribed = false;
    this._runLoop = true;
    this._debug = false;
    this._hasEnabledEvents = false;
    this.cancelReason = null;
    this._performType = PERFORM_TYPE_DEFAULT;
    this._expectsLinkedYield = false;
    /**
     * If this TaskInstance runs to completion by returning a property
     * other than a rejecting promise, this property will be set
     * with that value.
     *
     * @memberof TaskInstance
     * @instance
     * @readOnly
     */
    this.value = null;

    /**
     * If this TaskInstance is canceled or throws an error (or yields
     * a promise that rejects), this property will be set with that error.
     * Otherwise, it is null.
     *
     * @memberof TaskInstance
     * @instance
     * @readOnly
     */
    this.error = null;

    /**
     * True if the task instance is fulfilled.
     *
     * @memberof TaskInstance
     * @instance
     * @readOnly
     */
    this.isSuccessful = false;

    /**
     * True if the task instance resolves to a rejection.
     *
     * @memberof TaskInstance
     * @instance
     * @readOnly
     */
    this.isError = false;

    this.isCanceling = false;

    /**
     * True if the task instance has started, else false.
     *
     * @memberof TaskInstance
     * @instance
     * @readOnly
     */
    this.hasStarted = false;

    /**
     * True if the task has run to completion.
     *
     * @memberof TaskInstance
     * @instance
     * @readOnly
     */
    this.isFinished = false;

    this._index = 1;
    this._defer = null;
    this._finalizeCallbacks = null;
    this._generatorState = GENERATOR_STATE_BEFORE_CREATE;
    this._generatorValue = null;
  }

  /**
   * True if the task instance was canceled before it could run to completion.
   *
   * @memberof TaskInstance
   * @instance
   * @readOnly
   */
  get isCanceled() {
    return this.isCanceling && this.isFinished;
  }

  /**
   * True if the task is still running.
   *
   * @memberof TaskInstance
   * @instance
   * @readOnly
   */
  get isRunning() {
    return !this.isFinished;
  }

  /**
   * Describes the state that the task instance is in. Can be used for debugging,
   * or potentially driving some UI state. Possible values are:
   *
   * - `"dropped"`: task instance was canceled before it started
   * - `"canceled"`: task instance was canceled before it could finish
   * - `"finished"`: task instance ran to completion (even if an exception was thrown)
   * - `"running"`: task instance is currently running (returns true even if
   *     is paused on a yielded promise)
   * - `"waiting"`: task instance hasn't begun running yet (usually
   *     because the task is using the {@linkcode TaskProperty#enqueue .enqueue()}
   *     task modifier)
   *
   * The animated timeline examples on the [Task Concurrency](/#/docs/task-concurrency)
   * docs page make use of this property.
   *
   * @memberof TaskInstance
   * @instance
   * @readOnly
   */
  get state() {
    if (this.isDropped) {
      return "dropped";
    } else if (this.isCanceling) {
      return "canceled";
    } else if (this.isFinished) {
      return "finished";
    } else if (this.hasStarted) {
      return "running";
    } else {
      return "waiting";
    }
  }

  /**
   * True if the TaskInstance was canceled before it could
   * ever start running. For example, calling
   * {@linkcode Task#perform .perform()} twice on a
   * task with the {@linkcode TaskProperty#drop .drop()} modifier applied
   * will result in the second task instance being dropped.
   *
   * @memberof TaskInstance
   * @instance
   * @readOnly
   */
  get isDropped() {
    return this.isCanceling && !this.hasStarted;
  }

  _start() {
    if (this.hasStarted || this.isCanceling) {
      return this;
    }
    this.hasStarted = true;
    this._scheduleProceed(YIELDABLE_CONTINUE, undefined);
    return this;
  }

  toString() {
    let taskString = "" + this.task;
    return spliceSlice(taskString, -1, 0, `.perform()`);
  }

  /**
   * Cancels the task instance. Has no effect if the task instance has
   * already been canceled or has already finished running.
   *
   * @method cancel
   * @memberof TaskInstance
   * @instance
   */
  cancel(cancelReason = ".cancel() was explicitly called") {
    if (this.isCanceling || this.isFinished) {
      return;
    }
    this.isCanceling = true;

    let name = this.task._propertyName || "<unknown>";
    this.cancelReason = `TaskInstance '${name}' was canceled because ${cancelReason}. For more information, see: http://ember-concurrency.com/docs/task-cancelation-help`;

    if (this.hasStarted) {
      this._proceedSoon(YIELDABLE_CANCEL, null);
    } else {
      this._finalize(null, COMPLETION_CANCEL);
    }
  }

  get _promise() {
    if (!this._defer) {
      this._defer = defer();
      this._maybeResolveDefer();
    }
    return this._defer.promise;
  }

  _maybeResolveDefer() {
    if (!this._defer || !this._completionState) {
      return;
    }

    if (this._completionState === COMPLETION_SUCCESS) {
      this._defer.resolve(this.value);
    } else {
      this._defer.reject(this.error);
    }
  }

  /**
   * Returns a promise that resolves with the value returned
   * from the task's (generator) function, or rejects with
   * either the exception thrown from the task function, or
   * an error with a `.name` property with value `"TaskCancelation"`.
   *
   * @method then
   * @memberof TaskInstance
   * @instance
   * @return {Promise}
   */
  then() {
    this._promise.then.apply(this._promise, arguments);
  }

  /**
   * @method catch
   * @memberof TaskInstance
   * @instance
   * @return {Promise}
   */
  catch() {
    this._promise.catch.apply(null, arguments);
  }

  /**
   * @method finally
   * @memberof TaskInstance
   * @instance
   * @return {Promise}
   */
  finally() {
    this._promise.finally.apply(null, arguments);
  }

  _finalize(_value, _completionState) {
    let completionState = _completionState;
    let value = _value;
    this._index++;

    if (this.isCanceling) {
      completionState = COMPLETION_CANCEL;
      value = new Error(this.cancelReason);

      value.name = TASK_CANCELATION_NAME;
      value.taskInstance = this;
    }

    this._completionState = completionState;
    this._result = value;

    if (completionState === COMPLETION_SUCCESS) {
      this.isSuccessful = true;
      this.value = value;
    } else if (completionState === COMPLETION_ERROR) {
      this.isError = true;
      this.error = value;
    } else if (completionState === COMPLETION_CANCEL) {
      this.error = value;
    }

    this.isFinished = true;

    this._dispose();
    this._runFinalizeCallbacks();
    this._dispatchFinalizeEvents();
  }

  _onFinalize(callback) {
    if (!this._finalizeCallbacks) {
      this._finalizeCallbacks = [];
    }
    this._finalizeCallbacks.push(callback);

    if (this._completionState) {
      this._runFinalizeCallbacks();
    }
  }

  _runFinalizeCallbacks() {
    this._maybeResolveDefer();
    if (this._finalizeCallbacks) {
      for (let i = 0, l = this._finalizeCallbacks.length; i < l; ++i) {
        this._finalizeCallbacks[i]();
      }
      this._finalizeCallbacks = null;
    }

    this._maybeThrowUnhandledTaskErrorLater();
  }

  _maybeThrowUnhandledTaskErrorLater() {
    // this backports the Ember 2.0+ RSVP _onError 'after' microtask behavior to Ember < 2.0
    // if (!this._hasSubscribed && this._completionState === COMPLETION_ERROR) {
    //     if (!this._hasSubscribed && !didCancel(this.error)) {
    //         reject(this.error);
    //     }
    // }
  }

  _dispatchFinalizeEvents() {
    // switch (this._completionState) {
    //   case COMPLETION_SUCCESS:
    //     this._triggerEvent("succeeded", this);
    //     break;
    //   case COMPLETION_ERROR:
    //     this._triggerEvent("errored", this, get(this, "error"));
    //     break;
    //   case COMPLETION_CANCEL:
    //     this._triggerEvent("canceled", this, get(this, "cancelReason"));
    //     break;
    // }
  }

  /**
   * Runs any disposers attached to the task's most recent `yield`.
   * For instance, when a task yields a TaskInstance, it registers that
   * child TaskInstance's disposer, so that if the parent task is canceled,
   * _dispose() will run that disposer and cancel the child TaskInstance.
   *
   * @private
   */
  _dispose() {
    if (this._disposer) {
      let disposer = this._disposer;
      this._disposer = null;

      // TODO: test erroring disposer
      disposer();
    }
  }

  _isGeneratorDone() {
    let state = this._generatorState;
    return state === GENERATOR_STATE_DONE || state === GENERATOR_STATE_ERRORED;
  }

  /**
   * Calls .next()/.throw()/.return() on the task's generator function iterator,
   * essentially taking a single step of execution on the task function.
   *
   * @private
   */
  _resumeGenerator(nextValue, iteratorMethod) {
    console.assert(
      "The task generator function has already run to completion. This is probably an ember-concurrency bug.",
      !this._isGeneratorDone()
    );

    try {
      TASK_INSTANCE_STACK.push(this);

      let iterator = this._getIterator();
      let result = iterator[iteratorMethod](nextValue);

      this._generatorValue = result.value;
      if (result.done) {
        this._generatorState = GENERATOR_STATE_DONE;
      } else {
        this._generatorState = GENERATOR_STATE_HAS_MORE_VALUES;
      }
    } catch (e) {
      this._generatorValue = e;
      this._generatorState = GENERATOR_STATE_ERRORED;
    } finally {
      if (this._expectsLinkedYield) {
        if (
          !this._generatorValue ||
          this._generatorValue._performType !== PERFORM_TYPE_LINKED
        ) {
          console.warn(
            "You performed a .linked() task without immediately yielding/returning it. This is currently unsupported (but might be supported in future version of ember-concurrency)."
          );
        }
        this._expectsLinkedYield = false;
      }

      TASK_INSTANCE_STACK.pop();
    }
  }

  _getIterator() {
    if (!this.iterator) {
      this.iterator = this._makeIterator();
    }
    return this.iterator;
  }

  /**
   * Returns a generator function iterator (the object with
   * .next()/.throw()/.return() methods) using the task function
   * supplied to `task(...)`. It uses `apply` so that the `this`
   * context is the host object the task lives on, and passes
   * the args passed to `perform(...args)` through to the generator
   * function.
   *
   * `_makeIterator` is overridden in EncapsulatedTask to produce
   * an iterator based on the `*perform()` function on the
   * EncapsulatedTask definition.
   *
   * @private
   */
  _makeIterator() {
    return this.fn.apply(this.context, this.args);
  }

  /**
   * The TaskInstance internally tracks an index/sequence number
   * (the `_index` property) which gets incremented every time the
   * task generator function iterator takes a step. When a task
   * function is paused at a `yield`, there are two events that
   * cause the TaskInstance to take a step: 1) the yielded value
   * "resolves", thus resuming the TaskInstance's execution, or
   * 2) the TaskInstance is canceled. We need some mechanism to prevent
   * stale yielded value resolutions from resuming the TaskFunction
   * after the TaskInstance has already moved on (either because
   * the TaskInstance has since been canceled or because an
   * implementation of the Yieldable API tried to resume the
   * TaskInstance more than once). The `_index` serves as
   * that simple mechanism: anyone resuming a TaskInstance
   * needs to pass in the `index` they were provided that acts
   * as a ticket to resume the TaskInstance that expires once
   * the TaskInstance has moved on.
   *
   * @private
   */
  _advanceIndex(index) {
    if (this._index === index) {
      return ++this._index;
    }
  }

  _proceedSoon(yieldResumeType, value) {
    this._advanceIndex(this._index);
    setTimeout(() => this._proceed(yieldResumeType, value), 1);
  }

  proceed(index, yieldResumeType, value) {
    if (this._completionState) {
      return;
    }
    if (!this._advanceIndex(index)) {
      return;
    }
    this._proceedSoon(yieldResumeType, value);
  }

  _scheduleProceed(yieldResumeType, value) {
    if (this._completionState) {
      return;
    }
    this._proceed(yieldResumeType, value);
  }

  _proceed(yieldResumeType, value) {
    if (this._completionState) {
      return;
    }

    if (this._generatorState === GENERATOR_STATE_DONE) {
      this._handleResolvedReturnedValue(yieldResumeType, value);
    } else {
      this._handleResolvedContinueValue(yieldResumeType, value);
    }
  }

  _handleResolvedReturnedValue(yieldResumeType, value) {
    // decide what to do in the case of `return maybeYieldable`;
    // value is the resolved value of the yieldable. We just
    // need to decide how to finalize.
    console.assert(
      "expected completion state to be pending",
      this._completionState === COMPLETION_PENDING
    );
    console.assert(
      "expected generator to be done",
      this._generatorState === GENERATOR_STATE_DONE
    );

    switch (yieldResumeType) {
      case YIELDABLE_CONTINUE:
      case YIELDABLE_RETURN:
        this._finalize(value, COMPLETION_SUCCESS);
        break;
      case YIELDABLE_THROW:
        this._finalize(value, COMPLETION_ERROR);
        break;
      case YIELDABLE_CANCEL:
        this.isCanceling = true;
        this._finalize(null, COMPLETION_CANCEL);
        break;
    }
  }

  _handleResolvedContinueValue(_yieldResumeType, resumeValue) {
    let iteratorMethod = _yieldResumeType;
    if (iteratorMethod === YIELDABLE_CANCEL) {
      this.isCanceling = true;
      iteratorMethod = YIELDABLE_RETURN;
    }

    this._dispose();

    let beforeIndex = this._index;
    this._resumeGenerator(resumeValue, iteratorMethod);

    if (!this._advanceIndex(beforeIndex)) {
      return;
    }

    if (this._generatorState === GENERATOR_STATE_ERRORED) {
      this._finalize(this._generatorValue, COMPLETION_ERROR);
      return;
    }

    this._handleYieldedValue();
  }

  _handleYieldedValue() {
    let yieldedValue = this._generatorValue;
    if (!yieldedValue) {
      this._proceedWithSimpleValue(yieldedValue);
      return;
    }

    if (yieldedValue instanceof RawValue) {
      this._proceedWithSimpleValue(yieldedValue.value);
      return;
    }

    this._addDisposer(yieldedValue.__ec_cancel__);

    if (yieldedValue[yieldableSymbol]) {
      this._invokeYieldable(yieldedValue);
    } else if (typeof yieldedValue.then === "function") {
      handleYieldedUnknownThenable(yieldedValue, this, this._index);
    } else {
      this._proceedWithSimpleValue(yieldedValue);
    }
  }

  _proceedWithSimpleValue(yieldedValue) {
    this.proceed(this._index, YIELDABLE_CONTINUE, yieldedValue);
  }

  _addDisposer(maybeDisposer) {
    if (typeof maybeDisposer === "function") {
      let priorDisposer = this._disposer;
      if (priorDisposer) {
        this._disposer = () => {
          priorDisposer();
          maybeDisposer();
        };
      } else {
        this._disposer = maybeDisposer;
      }
    }
  }

  _invokeYieldable(yieldedValue) {
    try {
      let maybeDisposer = yieldedValue[yieldableSymbol](this, this._index);
      this._addDisposer(maybeDisposer);
    } catch (e) {
      console.error(e);
      // TODO: handle erroneous yieldable implementation
    }
  }

  // _triggerEvent(eventType, ...args) {
  //   if (!this._hasEnabledEvents) {
  //     return;
  //   }

  //   let host = this.task.context;
  //   let eventNamespace = this.task._propertyName);

  //   if (host && host.trigger && eventNamespace) {
  //     host.trigger(`${eventNamespace}:${eventType}`, ...args);
  //   }
  // }
}

TaskInstance.prototype[yieldableSymbol] = function handleYieldedTaskInstance(
  parentTaskInstance,
  resumeIndex
) {
  let yieldedTaskInstance = this;
  yieldedTaskInstance._hasSubscribed = true;

  yieldedTaskInstance._onFinalize(() => {
    let state = yieldedTaskInstance._completionState;
    if (state === COMPLETION_SUCCESS) {
      parentTaskInstance.proceed(
        resumeIndex,
        YIELDABLE_CONTINUE,
        yieldedTaskInstance.value
      );
    } else if (state === COMPLETION_ERROR) {
      parentTaskInstance.proceed(
        resumeIndex,
        YIELDABLE_THROW,
        yieldedTaskInstance.error
      );
    } else if (state === COMPLETION_CANCEL) {
      parentTaskInstance.proceed(resumeIndex, YIELDABLE_CANCEL, null);
    }
  });

  return function disposeYieldedTaskInstance() {
    if (yieldedTaskInstance._performType !== PERFORM_TYPE_UNLINKED) {
      if (yieldedTaskInstance._performType === PERFORM_TYPE_DEFAULT) {
        let parentObj = parentTaskInstance.task.context;
        let childObj = yieldedTaskInstance.task.context;
        if (
          parentObj &&
          childObj &&
          parentObj !== childObj &&
          parentObj.isDestroying &&
          yieldedTaskInstance.isRunning
        ) {
          let parentName = `\`${parentTaskInstance.task._propertyName}\``;
          let childName = `\`${yieldedTaskInstance.task._propertyName}\``;
          console.warn(
            `ember-concurrency detected a potentially hazardous "self-cancel loop" between parent task ${parentName} and child task ${childName}. If you want child task ${childName} to be canceled when parent task ${parentName} is canceled, please change \`.perform()\` to \`.linked().perform()\`. If you want child task ${childName} to keep running after parent task ${parentName} is canceled, change it to \`.unlinked().perform()\``
          );
        }
      }
      yieldedTaskInstance.cancel();
    }
  };
};

export function go(args, fn, attrs = {}) {
  return TaskInstance.create(
    Object.assign({ args, fn, context: this }, attrs)
  )._start();
}

export function wrap(fn, attrs = {}) {
  return function wrappedRunnerFunction(...args) {
    return go.call(this, args, fn, attrs);
  };
}

export default TaskInstance;
