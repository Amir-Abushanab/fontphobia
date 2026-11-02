import { Schema, pipe } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion, int, literal, slash } from 'foldkit/route'

export const AppRoute = defineRouteUnion({
  Home: {},
  About: {},
  Post: { id: Schema.Number },
  NotFound: { path: Schema.String },
})

export type AppRoute = typeof AppRoute.Type

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))
export const aboutRouter = pipe(literal('about'), Route.mapTo(AppRoute.About))
export const postRouter = pipe(
  literal('posts'),
  slash(int('id')),
  Route.mapTo(AppRoute.Post),
)

const routeParser = Route.oneOf(postRouter, aboutRouter, homeRouter)

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  AppRoute.NotFound,
)
