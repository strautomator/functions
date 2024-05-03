// Strautomator Functions: Subscriptions

import {BaseSubscription, GitHubSubscription, PayPalSubscription, UserData} from "strautomator-core"
import {FieldValue} from "@google-cloud/firestore"
import core = require("strautomator-core")
import _ from "lodash"
import dayjs from "dayjs"
import dayjsAdvancedFormat from "dayjs/plugin/advancedFormat"
import dayjsLocalizedFormat from "dayjs/plugin/localizedFormat"
import dayjsUTC from "dayjs/plugin/utc"
import logger from "anyhow"
const settings = require("setmeup").settings

// Extends dayjs with required plugins.
dayjs.extend(dayjsAdvancedFormat)
dayjs.extend(dayjsLocalizedFormat)
dayjs.extend(dayjsUTC)

/**
 * Generic helper method to make sure a subscription is still valid.
 * @param subscription Subscription data.
 * @param user User data.
 */
const validateSubscription = async (subscription: core.BaseSubscription, user: UserData): Promise<void> => {
    const now = dayjs.utc()

    // User not found? Delete very old subscriptions, and set recent to expired.
    if (!user) {
        logger.info("F.Subscriptions.validateSubscription", core.logHelper.subscriptionUser(subscription), "User not found")

        if (dayjs(subscription.dateUpdated).add(settings.users.idleDays.default, "days").isBefore(now)) {
            await core.subscriptions.delete(subscription)
        } else if (subscription.status != "EXPIRED") {
            subscription.status = "EXPIRED"
            subscription.dateExpiry = now.toDate()
            subscription.pendingUpdate = true
        }

        return
    }

    // Expired but still with an active-like status? Update to EXPIRED status and switch user to free.
    if (!["SUSPENDED", "CANCELLED", "EXPIRED"].includes(subscription.status) && subscription.dateExpiry && now.isAfter(subscription.dateExpiry)) {
        logger.info("F.Subscriptions.validateSubscription", core.logHelper.subscriptionUser(subscription), "Expired")
        subscription.status = "EXPIRED"
        subscription.pendingUpdate = true
        if (user.isPro) {
            await core.users.switchToFree(user, subscription)
        }
        return
    }

    // Subscription active but user not set to PRO? Just leave an alert.
    if (subscription.status == "ACTIVE" && !user.isPro) {
        logger.warn("F.Subscriptions.validateSubscription", core.logHelper.subscriptionUser(subscription), "Subscription active but user not PRO, will set to PRO now")
        const updatedUser: Partial<UserData> = {id: user.id, displayName: user.displayName, isPro: true, subscriptionId: subscription.id}
        if (user["subscription"] === null) {
            updatedUser["subscription"] = FieldValue.delete() as any
        }
        await core.users.update(updatedUser)
    }
}

/**
 * Save pending subscription updates to the database.
 * @param subs Subscriptions to be checked and saved.
 */
const saveSubscriptions = async (subs: (BaseSubscription | GitHubSubscription | PayPalSubscription)[]): Promise<void> => {
    for (let subscription of subs) {
        if (subscription.pendingUpdate) {
            await core.subscriptions.update(subscription)
        }
    }
}

/**
 * Validate non-active subscriptions.
 */
export const checkNonActive = async () => {
    logger.info("F.Subscriptions.checkNonActive.start")

    try {
        const danglingSubs = await core.subscriptions.getDangling()
        for (let subscription of danglingSubs) {
            try {
                await core.subscriptions.delete(subscription)

                // Clear the subscriptionId from the user if it's still pointing to this subscription.
                const user = await core.users.getById(subscription.userId)
                if (user && user.subscriptionId == subscription.id) {
                    const updatedUser = {id: user.id, displayName: user.displayName, subscriptionId: FieldValue.delete() as any}
                    await core.users.update(updatedUser)
                }
            } catch (subEx) {
                logger.error("F.Subscriptions.checkNonActive", core.logHelper.subscriptionUser(subscription), subEx)
            }
        }

        // Iterate and validate inactive subs.
        const subs = _.shuffle(await core.subscriptions.getNonActive())
        for (let subscription of subs) {
            const user = await core.users.getById(subscription.userId)
            await validateSubscription(subscription, user)
        }

        await saveSubscriptions(subs)
    } catch (ex) {
        logger.error("F.Subscriptions.checkNonActive", ex)
    }
}

/**
 * Clear PRO users without a valid subscription reference.
 */
export const checkMissing = async () => {
    logger.info("F.Subscriptions.checkMissing.start")

    try {
        const proUsers = await core.users.getPro()

        for (let user of proUsers) {
            try {
                const subscription = user.subscriptionId ? await core.subscriptions.getById(user.subscriptionId) : null
                if (!subscription) {
                    await core.users.switchToFree(user)
                }
            } catch (userEx) {
                logger.error("F.Subscriptions.checkMissing", core.logHelper.user(user), userEx)
            }
        }
    } catch (ex) {
        logger.error("F.Subscriptions.checkMissing", ex)
    }
}

/**
 * Validate GitHub subscriptions and make sure they're in sync with GitHub Sponsors.
 *
 */
export const checkGitHub = async () => {
    logger.info("F.Subscriptions.checkGitHub.start")

    try {
        const now = dayjs.utc()
        const liveData = await core.github.getActiveSponsors()

        // Iterate GitHub subscriptions and make sure they're in sync with GitHub Sponsors.
        const subs = _.shuffle(await core.subscriptions.getAll("github"))
        for (let subscription of subs) {
            try {
                const user = await core.users.getById(subscription.userId)
                await validateSubscription(subscription, user)
                if (!user.isPro) {
                    continue
                }

                // Skip recent subscriptions.
                if (now.diff(subscription.dateCreated, "days") < 30) {
                    logger.info("F.Subscriptions.checkGitHub", core.logHelper.subscriptionUser(subscription), "New subscription skipped")
                    continue
                }

                // Make sure PRO users are still active sponsors on GitHub.
                if (liveData && !liveData.find((s) => s.id == subscription.id)) {
                    logger.info("F.Subscriptions.checkGitHub", core.logHelper.subscriptionUser(subscription), "Not found or active on GitHub")
                    subscription.status = "EXPIRED"
                    subscription.pendingUpdate = true
                    await core.users.switchToFree(user, subscription)
                }
            } catch (subEx) {
                logger.error("F.Subscriptions.checkGitHub", core.logHelper.subscriptionUser(subscription), subEx)
            }
        }

        await saveSubscriptions(subs)
    } catch (ex) {
        logger.error("F.Subscriptions.checkGitHub", ex)
    }
}

/**
 * Validate PayPal subscriptions and make sure they're in sync with PayPal.
 */
export const checkPayPal = async () => {
    logger.info("F.Subscriptions.checkPayPal.start")

    try {
        const now = dayjs.utc()
        const subs = _.shuffle(await core.subscriptions.getAll("paypal"))

        // Iterate PayPal subscriptions and make sure their details are up to date.
        for (let subscription of subs) {
            try {
                const user = await core.users.getById(subscription.userId)
                await validateSubscription(subscription, user)
                if (!user || !user.isPro) {
                    continue
                }

                // Skip recent subscriptions.
                if (subscription.frequency != "lifetime" && now.diff(subscription.dateCreated, "weeks") < 4) {
                    logger.info("F.Subscriptions.checkPayPal", core.logHelper.subscriptionUser(subscription), "Skipped (too recent)")
                    continue
                }

                // Make sure subscription is in sync with live PayPal data.

                const liveData = (await core.paypal.subscriptions.getSubscription(subscription.id)) as core.PayPalSubscription
                const paypalSubscription = subscription as PayPalSubscription

                // Make sure payment data is correct.
                if (liveData.lastPayment && (!paypalSubscription.lastPayment || dayjs.utc(paypalSubscription.lastPayment.date).format("l") != dayjs.utc(liveData.lastPayment.date).format("l"))) {
                    paypalSubscription.lastPayment = liveData.lastPayment
                    paypalSubscription.price = liveData.lastPayment.amount
                    paypalSubscription.currency = liveData.lastPayment.currency
                    paypalSubscription.pendingUpdate = true
                }

                // Update status if it was cancelled and subscription is not lifetime.
                if (paypalSubscription.frequency != "lifetime") {
                    if (paypalSubscription.status != liveData.status) {
                        paypalSubscription.status = liveData.status
                        paypalSubscription.pendingUpdate = true
                    }

                    if (["SUSPENDED", "CANCELLED", "EXPIRED"].includes(paypalSubscription.status)) {
                        const lastPaymentDate = dayjs.utc(liveData.lastPayment?.date || liveData.dateUpdated)
                        const expiryDate = paypalSubscription.frequency == "monthly" ? lastPaymentDate.add(4, "weeks") : lastPaymentDate.add(11, "months")
                        if (now.isAfter(expiryDate)) {
                            logger.info("F.Subscriptions.checkPayPal", core.logHelper.subscriptionUser(subscription), "Unpaid subscription")
                            await core.users.switchToFree(user, paypalSubscription)
                        }
                    }
                }
            } catch (subEx) {
                logger.error("F.Subscriptions.checkPayPal", core.logHelper.subscriptionUser(subscription), subEx)
            }
        }

        await saveSubscriptions(subs)
    } catch (ex) {
        logger.error("F.Subscriptions.checkPayPal", ex)
    }
}

/**
 * Count how many subscriptions are there.
 */
export const countSubscriptions = async (): Promise<any> => {
    logger.info("F.Subscriptions.countSubscriptions")

    try {
        const total = await core.database.count("subscriptions")
        const active = await core.database.count("subscriptions", ["status", "==", "ACTIVE"])

        logger.info("F.Subscriptions.countSubscriptions", `Total: ${total}`, `Active: ${active}`)
        return {total: total, active: active}
    } catch (ex) {
        logger.error("F.Subscriptions.countSubscriptions", ex)
    }
}
