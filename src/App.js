import React, { useState, useEffect } from "react";
import logo from "./logo.svg";
import "./App.css";
import TaskInstance from "./TaskInstance.js";
import Task from "./Task.js";

window.TaskInstance = TaskInstance;

const engine = (generator, setTask) => {
  setTask(state => ({
    ...state,
    isIdle: false
  }));
  let gen = generator();
  let result = gen.next();
  Promise.resolve(result.value).then(value => {
    gen.next(value);
    setTask(state => ({
      ...state,
      isIdle: true
    }));
  });
};

const useTask = generator => {
  let taskInstance = new Task({ fn: generator });
  useEffect(function() {
    return taskInstance.cleanup;
  }, []);
  let task, setTask;
  let perform = () => {
    engine(generator, setTask);
  };

  [task, setTask] = useState(taskInstance);

  console.log("useTask");
  if (!window.task) {
    window.task = taskInstance;
  }

  let oldPerform = taskInstance.perform;
  taskInstance.perform = function() {
    let prom = oldPerform();
    setTask(taskInstance);
    prom.then(
      setTask.bind(null, taskInstance),
      setTask.bind(null, taskInstance)
    );
  };

  // taskInstance.then(() => {
  //   setTask(taskInstance);
  // }, setTask.bind(null, taskInstance));
  return task;
};

const timeout = time => {
  return new Promise(resolve => {
    setTimeout(resolve, time);
  });
};

const App = () => {
  let [result, setResult] = useState(null);
  let askQuestion = useTask(function*() {
    yield timeout(1000);
    let ret = Math.floor(Math.random() * 1000);
    setResult(ret);
    return ret;
  });

  // let askQuestion = useTask(function*() {
  //   yield timeout(1000);
  //   return Math.floor(Math.random() * 1000);
  // }).drop();
  return (
    <div className="App">
      <header className="App-header">
        <button
          className={askQuestion.isIdle ? "button-primary" : ""}
          onClick={askQuestion.perform}
        >
          {askQuestion.isIdle && "Ask"}
          {!askQuestion.isIdle && "Thinking..."}
        </button>

        <p>Result is: {result}</p>
      </header>
    </div>
  );
};

export default App;
