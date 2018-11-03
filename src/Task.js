import TaskInstance, {
  getRunningInstance,
  PERFORM_TYPE_DEFAULT,
  PERFORM_TYPE_UNLINKED,
  PERFORM_TYPE_LINKED
} from "./TaskInstance.js";
import Scheduler from "./Scheduler.js";
import {
  enqueueTasksPolicy,
  dropQueuedTasksPolicy,
  cancelOngoingTasksPolicy,
  dropButKeepLatestPolicy
} from "./buffer-policy.js";

class Task {
  /**
   * `true` if any current task instances are running.
   *
   * @memberof Task
   * @member {boolean} isRunning
   * @instance
   * @readOnly
   */

  /**
   * `true` if any future task instances are queued.
   *
   * @memberof Task
   * @member {boolean} isQueued
   * @instance
   * @readOnly
   */

  /**
   * `true` if the task is not in the running or queued state.
   *
   * @memberof Task
   * @member {boolean} isIdle
   * @instance
   * @readOnly
   */

  /**
   * The current state of the task: `"running"`, `"queued"` or `"idle"`.
   *
   * @memberof Task
   * @member {string} state
   * @instance
   * @readOnly
   */

  /**
   * The most recently started task instance.
   *
   * @memberof Task
   * @member {TaskInstance} last
   * @instance
   * @readOnly
   */

  /**
   * The most recent task instance that is currently running.
   *
   * @memberof Task
   * @member {TaskInstance} lastRunning
   * @instance
   * @readOnly
   */

  /**
   * The most recently performed task instance.
   *
   * @memberof Task
   * @member {TaskInstance} lastPerformed
   * @instance
   * @readOnly
   */

  /**
   * The most recent task instance that succeeded.
   *
   * @memberof Task
   * @member {TaskInstance} lastSuccessful
   * @instance
   * @readOnly
   */

  /**
   * The most recently completed task instance.
   *
   * @memberof Task
   * @member {TaskInstance} lastComplete
   * @instance
   * @readOnly
   */

  /**
   * The most recent task instance that errored.
   *
   * @memberof Task
   * @member {TaskInstance} lastErrored
   * @instance
   * @readOnly
   */

  /**
   * The most recently canceled task instance.
   *
   * @memberof Task
   * @member {TaskInstance} lastCanceled
   * @instance
   * @readOnly
   */

  /**
   * The most recent task instance that is incomplete.
   *
   * @memberof Task
   * @member {TaskInstance} lastIncomplete
   * @instance
   * @readOnly
   */

  /**
   * The number of times this task has been performed.
   *
   * @memberof Task
   * @member {number} performCount
   * @instance
   * @readOnly
   */

  constructor({
    fn,
    context,
    _origin,
    _taskGroupPath,
    _scheduler,
    _propertyName
  }) {
    this.fn = fn || null;
    this.context = context || null;
    this._origin = _origin || null;
    this._taskGroupPath = _taskGroupPath || null;
    this._propertyName = _propertyName || null;
    this._observes = null;
    this._curryArgs = null;
    this._linkedObjects = null;
    this.numRunning = 0;
    this.numQueued = 0;
    this._seenIndex = 0;
    this._scheduler = _scheduler || null;
    this._bufferPolicy = enqueueTasksPolicy;
    this._maxConcurrency = Infinity;
    this._taskGroupPath = null;
    this._hasUsedModifier = false;
    this._hasSetBufferPolicy = false;
    this.perform = this.perform.bind(this);
  }

  _curry(...args) {
    let task = this._clone();
    task._curryArgs = [...(this._curryArgs || []), ...args];
    return task;
  }

  linked() {
    // let taskInstance = getRunningInstance();
    // if (!taskInstance) {
    //   throw new Error(`You can only call .linked() from within a task.`);
    // }
    // return PerformProxy.create({
    //   _task: this,
    //   _performType: PERFORM_TYPE_LINKED,
    //   _linkedObject: taskInstance
    // });
  }

  unlinked() {
    // return PerformProxy.create({
    //   _task: this,
    //   _performType: PERFORM_TYPE_UNLINKED
    // });
  }

  _clone() {
    return new Task({
      fn: this.fn,
      context: this.context,
      _origin: this._origin,
      _taskGroupPath: this._taskGroupPath,
      _scheduler: this._scheduler,
      _propertyName: this._propertyName
    });
  }

  toString() {
    return `<Task:${this._propertyName}>`;
  }

  /**
   * Creates a new {@linkcode TaskInstance} and attempts to run it right away.
   * If running this task instance would increase the task's concurrency
   * to a number greater than the task's maxConcurrency, this task
   * instance might be immediately canceled (dropped), or enqueued
   * to run at later time, after the currently running task(s) have finished.
   *
   * @method perform
   * @memberof Task
   * @param {*} arg* - args to pass to the task function
   * @instance
   *
   * @fires TaskInstance#TASK_NAME:started
   * @fires TaskInstance#TASK_NAME:succeeded
   * @fires TaskInstance#TASK_NAME:errored
   * @fires TaskInstance#TASK_NAME:canceled
   *
   */
  perform(...args) {
    return this._performShared(args, PERFORM_TYPE_DEFAULT, null);
  }

  _performShared(args, performType, linkedObject) {
    let fullArgs = this._curryArgs ? [...this._curryArgs, ...args] : args;
    let taskInstance = new TaskInstance({
      fn: this.fn,
      args: fullArgs,
      context: this.context,
      owner: this.context,
      task: this,
      _debug: this._debug,
      _hasEnabledEvents: this._hasEnabledEvents,
      _origin: this,
      _performType: performType
    });

    if (performType === PERFORM_TYPE_LINKED) {
      linkedObject._expectsLinkedYield = true;
    }

    // if (this.context.isDestroying) {
    //   // TODO: express this in terms of lifetimes; a task linked to
    //   // a dead lifetime should immediately cancel.
    //   taskInstance.cancel();
    // }

    this._getScheduler().schedule(taskInstance);
    return taskInstance;
  }

  _getScheduler() {
    if (!this._scheduler) {
      this._scheduler = new Scheduler({
        bufferPolicy: this._bufferPolicy,
        maxConcurrency: this._maxConcurrency
      });
    }
    return this._scheduler;
  }

  get isRunning() {
    return this.numRunning > 0;
  }

  get isQueued() {
    return this.numQueued > 0;
  }

  get isIdle() {
    return !this.isRunning && !this.isQueued;
  }

  get state() {
    if (this.isRunning) {
      return "running";
    } else if (this.isQueued) {
      return "queued";
    } else {
      return "idle";
    }
  }

  get last() {
    return this._scheduler && this._scheduler.lastStarted;
  }

  get lastRunning() {
    return this._scheduler && this._scheduler.lastRunning;
  }

  get lastPerformed() {
    return this._scheduler && this._scheduler.lastPerformed;
  }

  get lastSuccessful() {
    return this._scheduler && this._scheduler.lastSuccessful;
  }

  get lastComplete() {
    return this._scheduler && this._scheduler.lastComplete;
  }

  get lastErrored() {
    return this._scheduler && this._scheduler.lastErrored;
  }

  get lastCanceled() {
    return this._scheduler && this._scheduler.lastCanceled;
  }

  get lastIncomplete() {
    return this._scheduler && this._scheduler.lastIncomplete;
  }

  get performCount() {
    return this._scheduler && this._scheduler.performCount;
  }

  cancelAll(reason = ".cancelAll() was explicitly called on the Task") {
    this._scheduler && this._scheduler.cancelAll(reason);
  }

  get group() {
    return this._taskGroupPath && this.context.get(this._taskGroupPath);
  }

  restartable() {
    return setBufferPolicy(this, cancelOngoingTasksPolicy);
  }

  enqueue() {
    return setBufferPolicy(this, enqueueTasksPolicy);
  }

  drop() {
    return setBufferPolicy(this, dropQueuedTasksPolicy);
  }

  keepLatest() {
    return setBufferPolicy(this, dropButKeepLatestPolicy);
  }

  maxConcurrency(n) {
    this._hasUsedModifier = true;
    this._maxConcurrency = n;
    // assertModifiersNotMixedWithGroup(this);
    return this;
  }
}

function setBufferPolicy(obj, policy) {
  obj._hasSetBufferPolicy = true;
  obj._hasUsedModifier = true;
  obj._bufferPolicy = policy;
  // assertModifiersNotMixedWithGroup(obj);

  if (obj._maxConcurrency === Infinity) {
    obj._maxConcurrency = 1;
  }

  return obj;
}

export default Task;
