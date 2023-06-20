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
            try {
                const user = await core.users.getById(subscription.userId)

                if (user?.isPro) {
                    if (!user.subscription) {
                        logger.warn("F.Users.cleanupSubscriptions", core.logHelper.user(user), "No subscription information on user")
                    }

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
            } catch (subEx) {
                logger.error("F.Users.cleanupSubscriptions", `Subscription ${subscription.id} - User ${subscription.userId}`, subEx)
            }
        }
    } catch (ex) {
        logger.error("F.Users.cleanupSubscriptions", ex)
    }
}

/**
 * Update the FTP and fitness level of users that have enabled that feature.
 */
export const performanceProcess = async () => {
    logger.info("F.Users.performanceProcess.start")

    try {
        const now = dayjs()
        const where = []
        where.push(["isPro", "==", true])
        where.push(["preferences.ftpAutoUpdate", "==", true])

        // Get and shuffle relevant users.
        let users: UserData[] = _.shuffle(await core.database.search("users", where))
        let totalCount = users.length

        // Filter users to be processed, based on their name and day of year.
        // The idea is to process roughly half of the total users per week.
        users = users.filter((u) => (u.profile.firstName || u.profile.lastName).charCodeAt(0) % 2 == now.dayOfYear() % 2)

        if (users.length == 0) {
            return logger.warn("F.Users.performanceProcess", "No users to be updated")
        }

        logger.info("F.Users.performanceProcess", `Will process ${users.length} out of ${totalCount} users`)

        // Helper function to force refresh the user token (if needed) and then process the FTP.
        const processPerformance = async (user: UserData) => {
            try {
                if (now.unix() >= user.stravaTokens.expiresAt) {
                    user.stravaTokens = await core.strava.refreshToken(user.stravaTokens.refreshToken, user.stravaTokens.accessToken)
                }

                // Process the user's FTP and fitness level.
                await core.strava.performance.processPerformance(user)
            } catch (jobEx) {
                logger.error("F.Users.performanceProcess", core.logHelper.user(user), jobEx)
            }
        }

        // Process FTP for the relevant users.
        const batchSize = settings.functions.batchSize
        while (users.length) {
            await Promise.all(users.splice(0, batchSize).map(processPerformance))
        }
    } catch (ex) {
        logger.error("F.Users.performanceProcess", ex)
    }
}

/**
 * Update the fitness level of a subset of recently active users.
 */
export const updateFitnessLevel = async () => {
    logger.info("F.Users.updateFitnessLevel.start")

    try {
        const now = dayjs()
        const batchSize = settings.functions.batchSize
        const dateFrom = now.subtract(settings.strava.fitnessLevel.weeks, "weeks").startOf("day")
        const where = [["dateLastActivity", ">", dateFrom.toDate()]]

        // Helper to fetch and set the fitness level of users.
        const processFitnessLevel = async (user: UserData) => {
            try {
                if (now.unix() >= user.stravaTokens.expiresAt) {
                    user.stravaTokens = await core.strava.refreshToken(user.stravaTokens.refreshToken, user.stravaTokens.accessToken)
                }

                // Check if fitness level has changed, and if so, update the database record.
                const fitnessLevel = await core.strava.performance.estimateFitnessLevel(user)
                if (user.fitnessLevel != fitnessLevel) {
                    user.fitnessLevel = fitnessLevel
                    await core.users.update({id: user.id, displayName: user.displayName, fitnessLevel: fitnessLevel})
                }
            } catch (jobEx) {
                logger.error("F.Users.updateFitnessLevel", core.logHelper.user(user), jobEx)
            }
        }

        // Get recently active users.
        const users: UserData[] = await core.database.search("users", where, null, 500)

        // Now filter up to 70 users that have no fitness level set and process them.
        const allNoLevelUsers = _.remove(users, (u) => !u.fitnessLevel)
        const noLevelUsers = _.sampleSize(allNoLevelUsers, 70)

        // Finally we update the fitness level of 30 random users that didn't have their FTP updated recently,
        // as the standard FTP update procedure already sets the fitness level as well.
        const allRandomUsers = _.remove(users, (u) => !u.ftpStatus || dateFrom.isAfter(u.ftpStatus.dateUpdated))
        const randomUsers = _.sampleSize(allRandomUsers, 30)

        // Process all filtered users.
        logger.info("F.Users.updateFitnessLevel", `Users to process: ${noLevelUsers.length || "none"} with no fitness level set yet, ${randomUsers.length || "none"} randomly chosen`)
        while (noLevelUsers.length) {
            await Promise.all(noLevelUsers.splice(0, batchSize).map(processFitnessLevel))
        }
        while (randomUsers.length) {
            await Promise.all(randomUsers.splice(0, batchSize).map(processFitnessLevel))
        }
    } catch (ex) {
        logger.error("F.Users.updateFitnessLevel", ex)
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
                const recipeId = stat?.id.split("-")[1]

                if (user) {
                    const recipe = user.recipes[recipeId]

                    // Recipe does not exist any longer? Archive the stats.
                    if (!recipe && !stat.dateArchived) {
                        logger.warn("F.Users.disableFailingRecipes", core.logHelper.user(user), `Recipe ${recipeId} does not exist`)
                        await core.recipes.stats.archiveStats(user, recipeId)
                        continue
                    }

                    // Recipe already disabled? Stop here.
                    if (recipe.disabled) {
                        logger.info("F.Users.disableFailingRecipes", core.logHelper.user(user), `Recipe ${recipeId} is already disabled`)
                        continue
                    }

                    if (!updatedUsers[user.id]) {
                        updatedUsers[user.id] = {id: user.id, recipes: user.recipes}
                    }

                    // Disable the current recipe.
                    updatedUsers[user.id].recipes[recipeId].disabled = true
                    logger.info("F.Users.disableFailingRecipes", core.logHelper.user(user), `Recipe ${recipeId} disabled`)
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
 * Delete archived stats.
 */
export const deleteArchivedStats = async (): Promise<any> => {
    logger.info("F.Users.deleteArchivedStats")

    try {
        await core.recipes.stats.deleteArchivedStats()
    } catch (ex) {
        logger.error("F.Users.deleteArchivedStats", ex)
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
export const countUsers = async (): Promise<any> => {
    logger.info("F.Users.countUsers")

    try {
        const total = await core.database.count("users")
        const active = total - (await core.database.count("users", ["suspended", "==", true]))
        const pro = await core.database.count("users", ["isPro", "==", true])

        logger.info("F.Users.countUsers", `Total: ${total}`, `Active: ${active}`, `Pro: ${pro}`)
        return {total: total, active: active, pro: pro}
    } catch (ex) {
        logger.error("F.Users.countUsers", ex)
    }
}

/**
 * Count how many subscriptions are there.
 */
export const countSubscriptions = async (): Promise<any> => {
    logger.info("F.Users.countSubscriptions")

    try {
        const total = await core.database.count("subscriptions")
        const active = await core.database.count("subscriptions", ["status", "==", "ACTIVE"])

        logger.info("F.Users.countSubscriptions", `Total: ${total}`, `Active: ${active}`)
        return {total: total, active: active}
    } catch (ex) {
        logger.error("F.Users.countSubscriptions", ex)
    }
}

/**
 * Count recipe usage details.
 */
export const countRecipeUsage = async (): Promise<any> => {
    logger.info("F.Users.countRecipeUsage")

    try {
        const recipeUsage: any = {}
        const users = await core.users.getActive()

        for (let pl of core.recipes.propertyList) {
            recipeUsage[`condition.${pl.value}`] = _.sum(users.map((u) => Object.values(u.recipes || []).filter((r) => r.conditions.find((rc) => rc.property == pl.value)).length))
        }
        for (let al of core.recipes.actionList) {
            recipeUsage[`action.${al.value}`] = _.sum(users.map((u) => Object.values(u.recipes || []).filter((r) => r.actions.find((ra) => ra.type == al.value)).length))
        }

        logger.info("F.Users.countSubscriptions", `Counted recipe usage for ${users.length} users`)
        return recipeUsage
    } catch (ex) {
        logger.error("F.Users.countRecipeUsage", ex)
    }
}
