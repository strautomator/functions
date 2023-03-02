// Strautomator Functions: Spotify

import core = require("strautomator-core")
import _ from "lodash"
import dayjs from "dayjs"
import dayjsDayOfYear from "dayjs/plugin/dayOfYear"
import logger = require("anyhow")
const settings = require("setmeup").settings
dayjs.extend(dayjsDayOfYear)

/**
 * Refresh Spotify tokens and profiles for users with expired tokens.
 */
export const refreshTokens = async () => {
    logger.info("F.Spotify.refreshTokens.start")

    try {
        const now = dayjs()
        const users = await core.users.getWithSpotify()
        let count = 0

        const refreshToken = async (user) => {
            if (user.spotify.tokens.expiresAt <= now.unix()) {
                const tokens = await core.spotify.refreshToken(user)
                const profile = await core.spotify.getProfile(user, tokens)
                await core.spotify.saveProfile(user, profile)
                count++
            }
        }

        // Refresh tokens in batches.
        const batchSize = settings.functions.batchSize
        while (users.length) {
            await Promise.all(users.splice(0, batchSize).map(refreshToken))
        }

        logger.info("F.Spotify.refreshTokens", `Refreshed ${count} profiles`)
    } catch (ex) {
        logger.error("F.Spotify.refreshTokens", ex)
    }
}
