import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'app-contact',
  templateUrl: './contact.component.html',
  styleUrls: ['./contact.component.css']
})
export class ContactComponent implements OnInit {

  name: string;
  subject: string;
  message: string;
  email: string;
  mailto = `mailto:me.mohakchugh@gmail.com?subject=${this.subject}&body=${this.email + ':' + this.message}`;
  constructor() { }

  ngOnInit(): void {
  }
}
