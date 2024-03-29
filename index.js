// Strautomator Functions: Main Wrapper

process.env.JSON_LOGGING = true

// Check if core has started.
const core = require("strautomator-core")
const startupCheck = async () => {
    if (!settings.app || !settings.gcp) {
        await core.startup(true)
    }
}

// Settings and individual function modules.
const settings = require("setmeup").settings
const gearwear = require("./lib/gearwear")
const maps = require("./lib/maps")
const notifications = require("./lib/notifications")
const spotify = require("./lib/spotify")
const strava = require("./lib/strava")
const subscriptions = require("./lib/subscriptions")
const users = require("./lib/users")
const logger = require("anyhow")

// Helper to update users, activities and usage stats.
const updateCounters = async () => {
    try {
        const stats = {
            activities: await strava.countActivities(),
            recipes: await users.countRecipeUsage(),
            users: await users.countUsers(),
            subscriptions: await subscriptions.countSubscriptions()
        }

        await core.database.appState.set("stats", stats)
    } catch (ex) {
        logger.warn("Functions.updateCounters", ex.message || ex.toString())
    }
}

// Daily tasks wrapper.
exports.dailyTasks = async () => {
    await startupCheck()

    try {
        await gearwear.processRecentActivities()
        await strava.setupWebhook()
        await strava.cleanupQueuedActivities()
        await strava.cleanupCache()
        await users.resetRecipeCounters()
    } catch (ex) {
        logger.warn("Functions.dailyTasks", ex.message || ex.toString())
    }

    return
}

// Monthly tasks (executed every first day of each month).
exports.monthlyTasks = async () => {
    await startupCheck()

    try {
        await notifications.sendEmailReminders()
        await users.deleteArchivedStats()
        await subscriptions.checkGitHub()
        await subscriptions.checkPayPal()
    } catch (ex) {
        logger.warn("Functions.monthlyTasks", ex.message || ex.toString())
    }

    return
}

// Weekend maintenance wrapper.
exports.weekendMaintenance = async () => {
    await startupCheck()

    try {
        await maps.cleanup()
        await notifications.cleanup()
        await strava.cleanupOldActivities()
        await users.cleanupIdle()
        await users.disableFailingRecipes()
        await users.updateFitnessLevel()
        await spotify.refreshTokens()
        await subscriptions.checkNonActive()
        await updateCounters()
    } catch (ex) {
        logger.warn("Functions.weekendMaintenance", ex.message || ex.toString())
    }

    return
}

// Weekly tasks (executed on Wednesday evening).
exports.weeklyTasks = async () => {
    await startupCheck()

    try {
        await users.performanceProcess()
        await subscriptions.checkNonActive()
        await updateCounters()
    } catch (ex) {
        logger.warn("Functions.weeklyTasks", ex.message || ex.toString())
    }

    return
}

// Beta weekly tasks wrapper. This will execute as a Beta environment
// having the $SMU_beta_enabled env variable set to 1.
exports.weeklyTasksBeta = async () => {
    process.env.SMU_beta_enabled = "1"

    await startupCheck()

    try {
        await strava.setupWebhook()
        await strava.cleanupCache()
        await strava.cleanupQueuedActivities()
        await strava.cleanupOldActivities()
        await gearwear.processRecentActivities()
        await users.disableFailingRecipes()
        await users.resetRecipeCounters()
        await maps.cleanup()
        await notifications.cleanup()
        await notifications.sendEmailReminders()
        await spotify.refreshTokens()
        await updateCounters()
    } catch (ex) {
        logger.warn("Functions.weeklyTasksBeta", ex.message || ex.toString())
    }

    return
}
