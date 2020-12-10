// TODO: place MetaStep in other file, disable rule
/* eslint-disable max-classes-per-file */
const stacktrace = require('stacktrace-js');
const store = require('./store');
const Secret = require('./secret');
const event = require('./event');

const STACK_LINE = 4;
const { insertHistory, getLastPageObject } = require('./cliHistory');
const { stringHash } = require('./utils');

/**
 * Each command in test executed through `I.` object is wrapped in Step.
 * Step allows logging executed commands and triggers hook before and after step execution.
 * @param {CodeceptJS.Helper} helper
 * @param {string} name
 */
class Step {
  constructor(helper, name) {
    /** @member {string} */
    this.actor = 'I'; // I = actor
    /** @member {CodeceptJS.Helper} */
    this.helper = helper; // corresponding helper
    /** @member {string} */
    this.name = name; // name of a step console
    /** @member {string} */
    this.helperMethod = name; // helper method
    /** @member {string} */
    this.status = 'pending';
    /**
     * @member {string} suffix
     * @memberof CodeceptJS.Step#
     */
    /** @member {string} */
    this.prefix = this.suffix = this.sessionPrefix = '';
    /** @member {string} */
    this.comment = '';
    this.callTree = [];
    /** @member {Array<*>} */
    this.args = [];
    /** @member {MetaStep} */
    this.metaStep = undefined;
    /** @member {string} */
    this.stack = '';
    this.setTrace();
  }

  /** @function */
  setTrace() {
    Error.captureStackTrace(this);
  }

  setCallTree() {
    const dd = stacktrace.getSync().reverse();
    dd.forEach((trace) => {
      if (trace.functionName) {
        if (trace.functionName.indexOf('Scenario') > -1
          || trace.functionName.indexOf('beforeSuite') > -1
          || trace.functionName.indexOf('before') > -1
          || trace.functionName.indexOf('afterSuite') > -1
          || trace.functionName.indexOf('after') > -1
          || trace.functionName.indexOf('within') > -1
          || trace.functionName.indexOf('session') > -1) {
          this.callTree.push({
            id: `${trace.columnNumber}-${trace.lineNumber}-${stringHash(trace.fileName)}`,
            parentid: 0,
          });
        }

        if ((trace.functionName.indexOf('Proxy') > -1 || trace.functionName.indexOf('Object') > -1) && trace.functionName.indexOf('Object.keys.map.forEach') === -1 && trace.functionName.indexOf('Object.obj.') === -1 && trace.fileName && trace.fileName.indexOf('container.js') === -1) {
          if (this.callTree.length === 0) {
            this.callTree = getLastPageObject();
          }
          this.callTree.push({
            id: `${trace.columnNumber}-${trace.lineNumber}-${stringHash(trace.fileName)}`,
            parentid: this.callTree[this.callTree.length - 1].id,
          });
        }
      }
    });

    const callTreeElem = this.callTree.length === 0 ? 0 : this.callTree.length - 1;

    this.callTree[callTreeElem] = {
      ...this.callTree[callTreeElem],
      step: { args: this.humanizeArgs(), name: this.humanize(), actor: this.actor },
    };
    insertHistory(this.callTree);
  }

  /** @param {Array<*>} args */
  setArguments(args) {
    this.args = args;
  }

  /**
   * @param {...any} args
   * @return {*}
   */
  run() {
    this.args = Array.prototype.slice.call(arguments);
    if (store.dryRun) {
      this.setStatus('success');
      return Promise.resolve(new Proxy({}, dryRunResolver()));
    }
    let result;
    try {
      result = this.helper[this.helperMethod].apply(this.helper, this.args);
      this.setStatus('success');
    } catch (err) {
      this.setStatus('failed');
      throw err;
    }
    return result;
  }

  /** @param {string} status */
  setStatus(status) {
    this.status = status;
    if (this.metaStep) {
      this.metaStep.setStatus(status);
    }
  }

  /** @return {string} */
  humanize() {
    return this.name
      // insert a space before all caps
      .replace(/([A-Z])/g, ' $1')
      // _ chars to spaces
      .replace('_', ' ')
      // uppercase the first character
      .replace(/^(.)|\s(.)/g, $1 => $1.toLowerCase());
  }

  /** @return {string} */
  humanizeArgs() {
    return this.args.map((arg) => {
      if (arg === null) {
        return 'null';
      }
      if (!arg) {
        return '';
      }
      if (typeof arg === 'string') {
        return `"${arg}"`;
      }
      if (Array.isArray(arg)) {
        try {
          const res = JSON.stringify(arg);
          return res;
        } catch (err) {
          return `[${arg.toString()}]`;
        }
      } else if (typeof arg === 'function') {
        return arg.toString();
      } else if (typeof arg === 'undefined') {
        return `${arg}`;
      } else if (arg instanceof Secret) {
        return '*****';
      } else if (arg.toString && arg.toString() !== '[object Object]') {
        return arg.toString();
      } else if (typeof arg === 'object') {
        return JSON.stringify(arg);
      }
      return arg;
    }).join(', ');
  }

  /** @return {string} */
  line() {
    const lines = this.stack.split('\n');
    if (lines[STACK_LINE]) {
      return lines[STACK_LINE].trim().replace(global.codecept_dir || '', '.').trim();
    }
    return '';
  }

  /** @return {string} */
  toString() {
    return `${this.prefix}${this.actor} ${this.humanize()} ${this.humanizeArgs()}${this.suffix}`;
  }

  /** @return {string} */
  toCode() {
    return `${this.prefix}${this.actor}.${this.name}(${this.humanizeArgs()})${this.suffix}`;
  }

  isMetaStep() {
    return this.constructor.name === 'MetaStep';
  }

  /** @return {boolean} */
  hasBDDAncestor() {
    let hasBDD = false;
    let processingStep;
    processingStep = this;

    while (processingStep.metaStep) {
      if (processingStep.metaStep.actor.match(/^(Given|When|Then|And)/)) {
        hasBDD = true;
        break;
      } else {
        processingStep = processingStep.metaStep;
      }
    }
    return hasBDD;
  }
}

/** @extends Step */
class MetaStep extends Step {
  constructor(obj, method) {
    super(null, method);
    this.actor = obj;
  }

  /** @return {boolean} */
  isBDD() {
    if (this.actor && this.actor.match && this.actor.match(/^(Given|When|Then|And)/)) {
      return true;
    }
    return false;
  }

  isWithin() {
    if (this.actor && this.actor.match && this.actor.match(/^(Within)/)) {
      return true;
    }
    return false;
  }

  toString() {
    const actorText = !this.isBDD() && !this.isWithin() ? `${this.actor}:` : this.actor;
    return `${this.prefix}${actorText} ${this.humanize()} ${this.humanizeArgs()}${this.suffix}`;
  }

  humanize() {
    return this.name;
  }

  setTrace() {
  }

  setContext(context) {
    this.context = context;
  }

  /** @return {*} */
  run(fn) {
    this.status = 'queued';
    this.setArguments(Array.from(arguments).slice(1));
    let result;

    const registerStep = (step) => {
      step.metaStep = this;
    };
    event.dispatcher.on(event.step.before, registerStep);
    try {
      this.startTime = Date.now();
      result = fn.apply(this.context, this.args);
    } catch (error) {
      this.status = 'failed';
    } finally {
      this.endTime = Date.now();

      event.dispatcher.removeListener(event.step.before, registerStep);
    }
    return result;
  }
}

/** @type {Class<MetaStep>} */
Step.MetaStep = MetaStep;

module.exports = Step;

function dryRunResolver() {
  return {
    get(target, prop) {
      if (prop === 'toString') return () => '<VALUE>';
      return new Proxy({}, dryRunResolver());
    },
  };
}
