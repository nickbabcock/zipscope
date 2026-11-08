// The lazy chunks of the archive lifecycle. The choice for a second file,
// the new-tab handoff and the reload code (file identity and stored
// handles) are not needed to show the first archive, so they load later.
// The front door preloads them with the workers, so they also work after a
// disconnect.

export const loadOpenChoice = () => import("./OpenChoice");
export const loadHandoff = () => import("./handoff");
export const loadRemember = () => import("./remember");
