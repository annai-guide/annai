// A budget for work a test must do in linear time (a hostile input must not make the code quadratic), counted in work done.

/**
 * The CPU time this process has used, in ms. A budget counts work done, not time passed: wall-clock time also counts the
 * seconds a busy machine takes the process off its CPU, which is what made such tests flake under load. The bounds should be
 * loose on purpose: code that is quadratic where it should be linear takes seconds of CPU on the inputs these tests use, far
 * over any of them. Take it before and after the work: cpuMs() - started.
 */
export const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
