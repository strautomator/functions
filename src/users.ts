// Strautomator Functions: Users

import {UserData} from "strautomator-core"
import core = require("strautomator-core")
import _ from "lodash"
import dayjs from "dayjs"
import dayjsDayOfYear from "dayjs/plugin/dayOfYear"
import logger = require("anyhow")
const settings = require("setmeup").settings
dayjs.extend(dayjsDayOfYear)

/**
 * Delete idle users. PRO users will be deleted only on beta environments.
 */
export const cleanupIdle = async () => {
    logger.info("F.Users.cleanupIdle.start")

    const idleUsers = await core.users.getIdle()

    try {
        for (const user of idleUsers) {
            if (user.isPro && !settings.beta.enabled) {
                logger.info("F.Users.cleanupIdle", `Idle user is PRO: ${user.id}`)
            } else {
                logger.info("F.Users.cleanupIdle", `Deleting idle user: ${user.id}`)
                await core.users.delete(user)
            }
        }
    } catch (ex) {
        logger.error("F.Users.cleanupIdle", ex)
    }
}

/**
 * Removed invalid (pending / dangling) subscriptions from the database,
 * and make sure users with non-active subscriptions are not PRO.
 */
export const cleanupSubscriptions = async () => {
    logger.info("F.Users.cleanupSubscriptions.start")

    try {
        const now = dayjs()
        const maxDate = dayjs().subtract(30, "days")

        // Remove dangling PayPal subscriptions.
        const danglingSubs = await core.users.subscriptions.getDangling()
        for (let subscription of danglingSubs) {
            await core.users.subscriptions.delete(subscription)
        }

        const subs = await core.users.subscriptions.getNonActive()

        // Iterate the non-active subscriptions and make sure these users have their isPro flag unset
        // in case it's been more than 6 months since the last update.
        for (let subscription of subs) {
            const user = await core.users.getById(subscription.userId)

            if (user && user.isPro) {
                if (user.subscription.source == "paypal") {
                    const paypalSub = (await core.paypal.subscriptions.getSubscription(subscription.id)) as core.PayPalSubscription

                    if (paypalSub.lastPayment && maxDate.isAfter(paypalSub.lastPayment.date)) {
                        await core.users.switchToFree(user, subscription)
                    }
                } else if (user.subscription.source == "github") {
                    const githubSub = (await core.users.subscriptions.getById(user.subscription.id)) as core.GitHubSubscription

                    if (githubSub && now.isAfter(githubSub.dateExpiry)) {
                        await core.users.switchToFree(user, subscription)
                    }
                } else if (user.subscription.source == "trial" && now.isAfter(user.subscription.dateExpiry)) {
                    await core.users.switchToFree(user)
                }
            } else {
                await core.users.subscriptions.delete(subscription)
            }
        }
    } catch (ex) {
        logger.error("F.Users.cleanupSubscriptions", ex)
    }
}

/**
 * Auto-update the FTP of users that have enabled that feature.
 */
export const ftpAutoUpdate = async () => {
    logger.info("F.Users.ftpAutoUpdate.start")

    try {
        const now = dayjs()
        const where = []
        where.push(["isPro", "==", true])
        where.push(["preferences.ftpAutoUpdate", "==", true])

        // Get and shuffle relevant users.
        let users: UserData[] = _.shuffle(await core.database.search("users", where))
        let totalCount = users.length

        // Filter users to be processed, based on their name and day of year.
        users = users.filter((u) => (u.profile.firstName || u.profile.lastName).charCodeAt(0) % 2 == now.dayOfYear() % 2)

        if (users.length == 0) {
            return logger.warn("F.Users.ftpAutoUpdate", "No users to be updated")
        }

        logger.info("F.Users.ftpAutoUpdate", `Will process ${users.length} out of ${totalCount} users`)

        // Helper function to force refresh the user token (if needed) and then process the FTP.
        const processFtp = async (user: UserData) => {
            if (now.unix() >= user.stravaTokens.expiresAt) {
                user.stravaTokens = await core.strava.refreshToken(user.stravaTokens.refreshToken, user.stravaTokens.accessToken)
            }

            delete user["dateLastFtpUpdate"]
            await core.strava.ftp.processFtp(user)
        }

        // Process FTP for the relevant users. Force refresh tokens first.
        const batchSize = settings.functions.batchSize
        while (users.length) {
            await Promise.all(users.splice(0, batchSize).map(processFtp))
        }
    } catch (ex) {
        logger.error("F.Users.ftpAutoUpdate", ex)
    }
}

/**
 * Disable automation recipes that failed to execute repeatedly, and notify the user.
 */
export const disableFailingRecipes = async () => {
    logger.info("F.Users.disableFailingRecipes.start")

    try {
        const recipeStats = await core.recipes.stats.getFailingRecipes()
        const updatedUsers: {[id: string]: any} = {}

        // Iterate list of failing recipes to disabled them.
        for (let stat of recipeStats) {
            try {
                const user = await core.users.getById(stat.userId)
                const recipeId = stat.id.split("-")[1]

                if (user) {
                    const recipe = user.recipes[recipeId]

                    // Recipe does not exist any longer? Archive the stats.
                    if (!recipe && !stat.archived) {
                        logger.warn("F.Users.disableFailingRecipes", `User ${user.id} ${user.displayName}`, `Recipe ${recipeId} does not exist`)
                        await core.recipes.stats.archiveStats(user, recipe)
                        continue
                    }

                    // Recipe already disabled? Stop here.
                    if (recipe.disabled) {
                        logger.info("F.Users.disableFailingRecipes", `User ${user.id} ${user.displayName}`, `Recipe ${recipeId} is already disabled`)
                        continue
                    }

                    if (!updatedUsers[user.id]) {
                        updatedUsers[user.id] = {id: user.id, recipes: user.recipes}
                    }

                    // Disable the current recipe.
                    updatedUsers[user.id].recipes[recipeId].disabled = true
                    logger.info("F.Users.disableFailingRecipes", `User ${user.id} ${user.displayName}`, `Recipe ${recipeId} disabled`)
                } else {
                    await core.recipes.stats.deleteStats(user, recipeId)
                }
            } catch (recipeEx) {
                logger.error("F.Users.disableFailingRecipes", `Recipe ${stat.id}`, recipeEx)
            }
        }

        // Save updated users with the disabled recipes.
        for (let user of Object.values(updatedUsers)) {
            await core.users.update(user)
        }
    } catch (ex) {
        logger.error("F.Users.disableFailingRecipes", ex)
    }
}

/**
 * Reset recipe counters for users that have enabled this option.
 */
export const resetRecipeCounters = async () => {
    logger.info("F.Users.resetRecipeCounters.start")

    try {
        const tomorrow = new Date(Date.now() + 3600 * 1000 * 24)
        const users = await core.users.getByResetCounter(tomorrow)

        // Iterate users and reset the recipe counters for each one of them.
        for (let user of users) {
            const recipes = Object.values(user.recipes)

            for (let recipe of recipes) {
                await core.recipes.stats.setCounter(user, recipe, 0)
            }
        }
    } catch (ex) {
        logger.error("F.Users.resetRecipeCounters", ex)
    }
}

/**
 * Count how many active, PRO and total users.
 */
export const countUsers = async () => {
    logger.info("F.Counters.countUsers")

    try {
        const total = await core.database.count("users")
        const active = total - (await core.database.count("users", ["suspended", "==", true]))
        const pro = await core.database.count("users", ["isPro", "==", true])

        await core.database.appState.set("stats", {users: {total: total, active: active, pro: pro}})
        logger.info("F.Counters.countUsers", `Total: ${total}`, `Active: ${active}`, `Pro: ${pro}`)
    } catch (ex) {
        logger.error("F.Counters.countUsers", ex)
    }
}

/**
 * Count how many subscriptions are there.
 */
export const countSubscriptions = async () => {
    logger.info("F.Counters.countSubscriptions")

    try {
        const total = await core.database.count("subscriptions")
        const active = await core.database.count("subscriptions", ["status", "==", "ACTIVE"])

        await core.database.appState.set("stats", {subscriptions: {total: total, active: active}})
        logger.info("F.Counters.countSubscriptions", `Total: ${total}`, `Active: ${active}`)
    } catch (ex) {
        logger.error("F.Counters.countSubscriptions", ex)
    }
}
