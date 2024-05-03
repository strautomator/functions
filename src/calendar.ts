// Strautomator Functions: Calendar

import core = require("strautomator-core")
import logger from "anyhow"
import dayjs from "dayjs"
const settings = require("setmeup").settings

/**
 * Cleanup old cached calendars.
 */
export const cleanup = async () => {
    logger.info("F.Calendar.cleanup.start")

    try {
        const maxDate = dayjs.utc().subtract(settings.users.idleDays.default, "days")
        const counter = await core.calendar.deleteCache(maxDate.toDate())
        logger.info("F.Calendar.cleanup", `Deleted ${counter} cached calendars`)
    } catch (ex) {
        logger.error("F.Calendar.cleanup", ex)
    }
}
