const userDefaults = new Map();

export function getUserDefaults(userId) {
  return userDefaults.get(userId) ?? {
    repo: null,
    projectId: null,
    milestoneValue: null,
    labelValues: [],
    assigneeLogins: [],
  };
}

export function setUserDefaults(userId, defaults) {
  userDefaults.set(userId, defaults);
}

export function clearDefaults() {
  userDefaults.clear();
}
