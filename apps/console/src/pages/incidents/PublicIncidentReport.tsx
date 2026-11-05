// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { isAxiosError } from "axios"
import {
  Ban,
  Camera,
  CircleHelp,
  ClipboardList,
  Hammer,
  Loader2,
  LocateFixed,
  MapPin,
  PowerOff,
  Search,
  ShieldCheck,
  Siren,
  TriangleAlert,
  X,
} from "lucide-react"
import { publicApi } from "../../api/public"
import { uploadPublicFile } from "../../lib/files"
import { Turnstile } from "../../components/Turnstile"
import Header from "../../components/Header"
import Footer from "../../components/Footer"
import { useI18n } from "../../lib/i18n-context"
import { LINKS } from "../../lib/site"
import type { IncidentCategory, IncidentCreateRequest, IncidentSeverity } from "../../types/incident"

type PublicIncidentErrorResponse = { detail?: string }

/** The public endpoint also accepts uploaded photo ids and a private contact block. */
type PublicIncidentCreate = IncidentCreateRequest & {
  photos?: string[]
  contact_info?: { name?: string; phone_number?: string }
}

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || ""
const MAX_PHOTOS = 5

const CATEGORIES: Array<{ id: IncidentCategory; icon: typeof PowerOff }> = [
  { id: "malfunction", icon: PowerOff },
  { id: "damage", icon: Hammer },
  { id: "safety_hazard", icon: TriangleAlert },
  { id: "vandalism", icon: Ban },
  { id: "other", icon: CircleHelp },
]

const SEVERITIES: Array<{ id: IncidentSeverity; on: string; dot: string }> = [
  { id: "low", on: "border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200", dot: "bg-emerald-500" },
  { id: "medium", on: "border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200", dot: "bg-amber-500" },
  { id: "high", on: "border-orange-500 bg-orange-50 text-orange-800 dark:bg-orange-950/60 dark:text-orange-200", dot: "bg-orange-500" },
  { id: "critical", on: "border-red-500 bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200", dot: "bg-red-500" },
]

const field =
  "w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-slate-900 placeholder:text-slate-400 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/30 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500"
const label = "mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
const card = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="flex items-center gap-3 text-lg font-semibold text-slate-900 dark:text-white">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-linear-to-br from-amber-400 to-orange-500 text-sm font-bold text-white">
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function FieldError({ children }: { children?: string }) {
  if (!children) return null
  return <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">{children}</p>
}

const PublicIncidentReport: React.FC = () => {
  const navigate = useNavigate()
  const { m } = useI18n()
  const r = m.report

  const [category, setCategory] = useState<IncidentCategory>("malfunction")
  const [severity, setSeverity] = useState<IncidentSeverity>("medium")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [address, setAddress] = useState("")
  const [lat, setLat] = useState("")
  const [lng, setLng] = useState("")
  const [showCoords, setShowCoords] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState("")
  const [photos, setPhotos] = useState<Array<{ file: File; url: string }>>([])
  const [contactName, setContactName] = useState("")
  const [contactPhone, setContactPhone] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [uploading, setUploading] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState("")
  const [lookupReference, setLookupReference] = useState("")
  const [lookupError, setLookupError] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  const photosRef = useRef(photos)

  useEffect(() => {
    photosRef.current = photos
  }, [photos])

  // Free preview URLs when leaving the page.
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), [])

  const createMutation = useMutation({
    mutationFn: (data: PublicIncidentCreate) => publicApi.createAnonymousIncident(data, turnstileToken),
    onSuccess: (incident) => {
      navigate({
        to: "/public/incidents/$incidentId",
        params: { incidentId: incident.incident_number || incident.id },
      })
    },
    onError: (error: unknown) => {
      const detail = isAxiosError<PublicIncidentErrorResponse>(error) ? error.response?.data?.detail : undefined
      setErrors({ submit: detail || r.errors.submit })
    },
  })

  const lookupMutation = useMutation({
    mutationFn: (reference: string) => publicApi.lookupPublicIncident(reference),
    onSuccess: (incident) => {
      setLookupError("")
      navigate({
        to: "/public/incidents/$incidentId",
        params: { incidentId: incident.incident_number || incident.id },
      })
    },
    onError: () => setLookupError(r.lookupNotFound),
  })

  const handleLookupSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const reference = lookupReference.trim()
    if (!reference) {
      setLookupError(r.lookupEmpty)
      return
    }
    setLookupError("")
    lookupMutation.mutate(reference)
  }

  const locateMe = () => {
    if (!navigator.geolocation) {
      setLocationError(r.locationDenied)
      setShowCoords(true)
      return
    }
    setLocating(true)
    setLocationError("")
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6))
        setLng(pos.coords.longitude.toFixed(6))
        setLocating(false)
      },
      () => {
        setLocating(false)
        setLocationError(r.locationDenied)
        setShowCoords(true)
      },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const addPhotos = (files: FileList | null) => {
    if (!files) return
    const room = MAX_PHOTOS - photos.length
    const next = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, Math.max(0, room))
      .map((file) => ({ file, url: URL.createObjectURL(file) }))
    setPhotos((prev) => [...prev, ...next])
    if (fileInput.current) fileInput.current.value = ""
  }

  const removePhoto = (url: string) => {
    URL.revokeObjectURL(url)
    setPhotos((prev) => prev.filter((p) => p.url !== url))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!title.trim()) next.title = r.errors.title
    if (!description.trim()) next.description = r.errors.description
    if (!address.trim()) next.address = r.errors.address
    if (TURNSTILE_SITE_KEY && !turnstileToken) next.captcha = r.errors.captcha
    setErrors(next)
    if (Object.keys(next).length) return

    // Photos go up first so a failed upload never leaves a report without them.
    let photoIds: string[] = []
    if (photos.length) {
      setUploading(true)
      try {
        const uploaded = await Promise.all(photos.map((p) => uploadPublicFile(p.file)))
        photoIds = uploaded.map((f) => f.file_id)
      } catch {
        setErrors({ photos: r.errors.photos })
        return
      } finally {
        setUploading(false)
      }
    }

    const latitude = parseFloat(lat)
    const longitude = parseFloat(lng)
    const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude)
    const contact = contactName.trim() || contactPhone.trim()
      ? { name: contactName.trim(), phone_number: contactPhone.trim() }
      : undefined

    createMutation.mutate({
      title: title.trim(),
      description: description.trim(),
      category,
      severity,
      location: {
        address: address.trim(),
        geometry: { type: "Point", coordinates: hasCoords ? [longitude, latitude] : [0, 0] },
      },
      ...(photoIds.length ? { photos: photoIds } : {}),
      ...(contact ? { contact_info: contact } : {}),
    })
  }

  const busy = uploading || createMutation.isPending
  const hasCoords = lat !== "" && lng !== ""

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header />

      {/* Intro */}
      <section className="border-b border-amber-100 bg-linear-to-br from-amber-50 via-white to-orange-50 pt-28 pb-12 dark:border-amber-950 dark:from-amber-950/30 dark:via-slate-950 dark:to-orange-950/20">
        <div className="mx-auto max-w-6xl px-4 text-center sm:px-6 lg:px-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <ClipboardList className="h-4 w-4" />
            {r.kicker}
          </span>
          <h1 className="mt-4 text-3xl font-bold text-balance text-slate-900 md:text-4xl dark:text-white">{r.title}</h1>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-balance text-slate-600 dark:text-slate-300">{r.lead}</p>
        </div>
      </section>

      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_20rem] lg:px-8">
        {/* Report form */}
        <form onSubmit={handleSubmit} noValidate className={`${card} space-y-10 p-6 md:p-8`}>
          <Section step={1} title={r.whatTitle}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {CATEGORIES.map(({ id, icon: Icon }) => {
                const on = category === id
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCategory(id)}
                    className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 px-2 py-3 text-center text-sm leading-tight font-medium transition ${
                      on
                        ? "border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
                        : "border-slate-200 bg-white text-slate-600 hover:border-amber-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {r.categories[id]}
                  </button>
                )
              })}
            </div>
            <div>
              <label htmlFor="report-title" className={label}>{r.titleLabel}</label>
              <input id="report-title" className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={r.titlePlaceholder} maxLength={160} />
              <FieldError>{errors.title}</FieldError>
            </div>
            <div>
              <label htmlFor="report-detail" className={label}>{r.detailLabel}</label>
              <textarea id="report-detail" className={`${field} min-h-32`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={r.detailPlaceholder} rows={5} />
              <FieldError>{errors.description}</FieldError>
            </div>
          </Section>

          <Section step={2} title={r.severityTitle}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {SEVERITIES.map(({ id, on, dot }) => {
                const active = severity === id
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSeverity(id)}
                    className={`rounded-xl border-2 px-3 py-3 text-left transition ${
                      active ? on : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
                    }`}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
                      {r.severities[id].label}
                    </span>
                    <span className="mt-0.5 block text-xs opacity-80">{r.severities[id].hint}</span>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section step={3} title={r.locationTitle}>
            <div>
              <label htmlFor="report-address" className={label}>{r.addressLabel}</label>
              <div className="relative">
                <MapPin className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input id="report-address" className={`${field} pl-10`} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={r.addressPlaceholder} />
              </div>
              <FieldError>{errors.address}</FieldError>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={locateMe}
                disabled={locating}
                className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300 dark:hover:bg-amber-950"
              >
                {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <LocateFixed className="h-4 w-4" />}
                {locating ? r.locating : r.useMyLocation}
              </button>
              <button
                type="button"
                onClick={() => setShowCoords((v) => !v)}
                className="text-sm font-medium text-slate-600 underline-offset-4 hover:underline dark:text-slate-300"
              >
                {r.manualCoords}
              </button>
            </div>
            {hasCoords && !showCoords && (
              <p className="text-sm text-emerald-700 dark:text-emerald-400">{r.located(lat, lng)}</p>
            )}
            {locationError && <p className="text-sm text-amber-700 dark:text-amber-400">{locationError}</p>}
            {showCoords && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="report-lat" className={label}>{r.latitude}</label>
                  <input id="report-lat" type="number" step="any" inputMode="decimal" className={field} value={lat} onChange={(e) => setLat(e.target.value)} placeholder="16.0544" />
                </div>
                <div>
                  <label htmlFor="report-lng" className={label}>{r.longitude}</label>
                  <input id="report-lng" type="number" step="any" inputMode="decimal" className={field} value={lng} onChange={(e) => setLng(e.target.value)} placeholder="108.2022" />
                </div>
              </div>
            )}
          </Section>

          <Section step={4} title={r.photosTitle}>
            <p className="-mt-2 text-sm text-slate-500 dark:text-slate-400">{r.photosHint}</p>
            <div className="flex flex-wrap gap-3">
              {photos.map((p) => (
                <div key={p.url} className="relative h-24 w-24 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                  <img src={p.url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removePhoto(p.url)}
                    aria-label={r.removePhoto}
                    className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {photos.length < MAX_PHOTOS && (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="flex h-24 min-w-24 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 px-4 text-sm font-medium text-slate-600 hover:border-amber-400 hover:text-amber-700 dark:border-slate-700 dark:text-slate-300 dark:hover:text-amber-300"
                >
                  <Camera className="h-5 w-5" />
                  {r.addPhotos}
                </button>
              )}
              <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => addPhotos(e.target.files)} />
            </div>
            <FieldError>{errors.photos}</FieldError>
          </Section>

          <Section step={5} title={r.contactTitle}>
            <p className="-mt-2 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
              {r.contactHint}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="report-name" className={label}>{r.nameLabel}</label>
                <input id="report-name" className={field} value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" />
              </div>
              <div>
                <label htmlFor="report-phone" className={label}>{r.phoneLabel}</label>
                <input id="report-phone" type="tel" className={field} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} autoComplete="tel" />
              </div>
            </div>
          </Section>

          {TURNSTILE_SITE_KEY && (
            <div>
              <p className={label}>{r.captchaLabel}</p>
              <Turnstile
                siteKey={TURNSTILE_SITE_KEY}
                onVerify={(token) => setTurnstileToken(token)}
                onExpire={() => setTurnstileToken("")}
                onError={() => setErrors({ captcha: r.errors.captchaFailed })}
                theme="auto"
                className="mt-2"
              />
              <FieldError>{errors.captcha}</FieldError>
            </div>
          )}

          <div>
            {errors.submit && (
              <p className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {errors.submit}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-linear-to-r from-amber-500 to-orange-500 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-amber-500/25 transition hover:shadow-xl disabled:cursor-wait disabled:opacity-70"
            >
              {busy && <Loader2 className="h-5 w-5 animate-spin" />}
              {uploading ? r.uploadingPhotos : createMutation.isPending ? r.submitting : r.submit}
            </button>
          </div>
        </form>

        {/* Side column */}
        <aside className="space-y-6">
          <div id="lookup-status" className={`${card} scroll-mt-28`}>
            <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
              <Search className="h-4 w-4 text-sky-600 dark:text-sky-400" />
              {r.lookupTitle}
            </h2>
            <p className="mt-2 text-sm text-pretty text-slate-600 dark:text-slate-400">{r.lookupText}</p>
            <form onSubmit={handleLookupSubmit} className="mt-4 space-y-3">
              <input className={field} value={lookupReference} onChange={(e) => setLookupReference(e.target.value)} placeholder={r.lookupPlaceholder} />
              <button
                type="submit"
                disabled={lookupMutation.isPending}
                className="w-full rounded-full bg-linear-to-r from-cyan-500 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md disabled:opacity-70"
              >
                {lookupMutation.isPending ? r.lookupLoading : r.lookupButton}
              </button>
            </form>
            <FieldError>{lookupError}</FieldError>
          </div>

          <div className={card}>
            <h2 className="font-semibold text-slate-900 dark:text-white">{r.nextTitle}</h2>
            <ol className="mt-4 space-y-4">
              {r.next.map((text, i) => (
                <li key={text} className="flex gap-3 text-sm text-slate-600 dark:text-slate-300">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                    {i + 1}
                  </span>
                  <span className="text-pretty">{text}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-2xl border border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40">
            <p className="flex gap-2 text-sm font-medium text-pretty text-red-800 dark:text-red-200">
              <Siren className="mt-0.5 h-4 w-4 shrink-0" />
              {r.emergency}
            </p>
            <a href={LINKS.sos} className="mt-3 inline-block text-sm font-semibold text-red-700 hover:underline dark:text-red-300">
              {r.emergencyLink} →
            </a>
          </div>
        </aside>
      </main>

      <Footer />
    </div>
  )
}

export default PublicIncidentReport
