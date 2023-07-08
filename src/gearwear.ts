// Strautomator Functions: GearWear

import {GearWearDbState} from "strautomator-core"
import core = require("strautomator-core")
import logger from "anyhow"

/**
 * Process recent Strava activities and update GearWear stats.
 */
export const processRecentActivities = async () => {
    logger.info("F.GearWear.processRecentActivities.start")

    try {
        await core.gearwear.processRecentActivities()

        const state: GearWearDbState = await core.database.appState.get("gearwear")

        if (state.recentActivityCount > 0) {
            logger.info("F.GearWear.processRecentActivities", "OK")
        } else {
            logger.info("F.GearWear.processRecentActivities", "No activities processed recently")
        }
    } catch (ex) {
        logger.error("F.GearWear.processRecentActivities", ex)
    }
}
