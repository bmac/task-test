let SEEN_INDEX = 0;

const once = function(cb) {
  Promise.resolve().then(cb);
};

class Scheduler {
  constructor({ bufferPolicy, maxConcurrency }) {
    this.bufferPolicy = bufferPolicy;
    this.maxConcurrency = maxConcurrency;
    this.activeTaskInstances = [];
    this.queuedTaskInstances = [];

    this.lastPerformed = null;
    this.lastStarted = null;
    this.lastRunning = null;
    this.lastSuccessful = null;
    this.lastComplete = null;
    this.lastErrored = null;
    this.lastCanceled = null;
    this.lastIncomplete = null;
    this.performCount = 0;

    this.boundHandleFulfill = null;
    this.boundHandleReject = null;
  }

  cancelAll(reason) {
    let seen = [];
    this.spliceTaskInstances(
      reason,
      this.activeTaskInstances,
      0,
      this.activeTaskInstances.length,
      seen
    );
    this.spliceTaskInstances(
      reason,
      this.queuedTaskInstances,
      0,
      this.queuedTaskInstances.length,
      seen
    );
    flushTaskCounts(seen);
  }

  spliceTaskInstances(cancelReason, taskInstances, index, count, seen) {
    for (let i = index; i < index + count; ++i) {
      let taskInstance = taskInstances[i];

      if (!taskInstance.hasStarted) {
        // This tracking logic is kinda spread all over the place...
        // maybe TaskInstances themselves could notify
        // some delegate of queued state changes upon cancelation?
        taskInstance.task.decrementProperty("numQueued");
      }

      taskInstance.cancel(cancelReason);
      if (seen) {
        seen.push(taskInstance.task);
      }
    }
    taskInstances.splice(index, count);
  }

  schedule(taskInstance) {
    this.lastPerformed = taskInstance;
    this.performCount += 1;
    taskInstance.task.numQueued += 1;
    this.queuedTaskInstances.push(taskInstance);
    this._flushQueues();
  }

  _flushQueues() {
    let seen = [];

    for (let i = 0; i < this.activeTaskInstances.length; ++i) {
      seen.push(this.activeTaskInstances[i].task);
    }

    this.activeTaskInstances = filterFinished(this.activeTaskInstances);

    this.bufferPolicy.schedule(this);

    var lastStarted = null;
    for (let i = 0; i < this.activeTaskInstances.length; ++i) {
      let taskInstance = this.activeTaskInstances[i];
      if (!taskInstance.hasStarted) {
        this._startTaskInstance(taskInstance);
        lastStarted = taskInstance;
      }
      seen.push(taskInstance.task);
    }

    if (lastStarted) {
      this.lastStarted = lastStarted;
    }
    this.lastRunning = lastStarted;

    for (let i = 0; i < this.queuedTaskInstances.length; ++i) {
      seen.push(this.queuedTaskInstances[i].task);
    }

    flushTaskCounts(seen);
    this.concurrency = this.activeTaskInstances.length;
  }

  _startTaskInstance(taskInstance) {
    let task = taskInstance.task;
    task.numQueued -= 1;
    task.numRunning += 1;

    taskInstance._start()._onFinalize(() => {
      task.numRunning -= 1;
      var state = taskInstance._completionState;
      this.lastComplete = taskInstance;
      if (state === 1) {
        this.lastSuccessful = taskInstance;
      } else {
        if (state === 2) {
          this.lastErrored = taskInstance;
        } else if (state === 3) {
          this.lastCanceled = taskInstance;
        }
        this.lastIncomplete = taskInstance;
      }
      once(this, this._flushQueues);
    });
  }
}

function flushTaskCounts(tasks) {
  SEEN_INDEX++;
  for (let i = 0, l = tasks.length; i < l; ++i) {
    let task = tasks[i];
    if (task._seenIndex < SEEN_INDEX) {
      task._seenIndex = SEEN_INDEX;
      updateTaskChainCounts(task);
    }
  }
}

function updateTaskChainCounts(task) {
  let numRunning = task.numRunning;
  let numQueued = task.numQueued;
  let taskGroup = task.group;

  while (taskGroup) {
    taskGroup.numRunning = numRunning;
    taskGroup.numQueued = numQueued;
    taskGroup = taskGroup.group;
  }
}

function filterFinished(taskInstances) {
  let ret = [];
  for (let i = 0, l = taskInstances.length; i < l; ++i) {
    let taskInstance = taskInstances[i];
    if (taskInstance.isFinished === false) {
      ret.push(taskInstance);
    }
  }
  return ret;
}

export default Scheduler;
