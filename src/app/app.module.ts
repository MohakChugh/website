import { BrowserModule } from '@angular/platform-browser';
import { NgModule } from '@angular/core';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { IndexComponent } from './index/index.component';
import { CvComponent } from './cv/cv.component';
import { ContactComponent } from './contact/contact.component';
import { ProjectsComponent } from './projects/projects.component';
import { NavbarComponent } from './navbar/navbar.component';
import { FooterComponent } from './footer/footer.component';
import { FarmersappComponent } from './projects/farmersapp/farmersapp.component';
import { CitizensappComponent } from './projects/citizensapp/citizensapp.component';
import { PropertyManagementComponent } from './projects/property-management/property-management.component';
import { ContentPusherComponent } from './projects/content-pusher/content-pusher.component';
import { FormsModule } from '@angular/forms';
import { BlogsComponent } from './blogs/blogs.component';
import { DroneDashComponent } from './projects/drone-dash/drone-dash.component';
import { SocialMediaAccordianComponent } from './contact/social-media-accordian/social-media-accordian.component';
import { ServiceWorkerModule } from '@angular/service-worker';
import { environment } from '../environments/environment';
import { ClassifierSelectorComponent } from './projects/classifier-selector/classifier-selector.component';
import { UniqueBlogComponent } from './unique-blog/unique-blog.component';

@NgModule({
  declarations: [
    AppComponent,
    IndexComponent,
    CvComponent,
    ContactComponent,
    ProjectsComponent,
    NavbarComponent,
    FooterComponent,
    FarmersappComponent,
    CitizensappComponent,
    PropertyManagementComponent,
    ContentPusherComponent,
    BlogsComponent,
    DroneDashComponent,
    SocialMediaAccordianComponent,
    ClassifierSelectorComponent,
    UniqueBlogComponent
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    FormsModule,
    ServiceWorkerModule.register('ngsw-worker.js', { enabled: environment.production }),
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule { }
